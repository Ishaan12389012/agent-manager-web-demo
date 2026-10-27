// Task assignment backed by Postgres. The rules themselves live in ./assign.js.
const { pool } = require('../db/pool');
const A = require('./assign');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const OPEN = ['assigned', 'accepted'];
const isExec = (u) => u.role === 'admin' || u.role === 'exec';
const requireExec = (u) => { if (!isExec(u)) throw new HttpError(403, 'Only an exec or admin can do that.'); };

async function withTx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally { c.release(); }
}

// ---- Loading ----

async function loadAnalysts(c) {
  const { rows } = await c.query(`
    SELECT u.id, u.name, u.email, a.trust_score::float AS "trustScore", a.max_open_tasks AS "maxOpenTasks",
           a.last_assigned_at AS "lastAssignedAt", a.profile_summary AS "profileSummary",
           (SELECT count(*)::int FROM tasks t WHERE t.assignee_id = u.id AND t.status = ANY($1)) AS "openTasks"
    FROM users u JOIN analysts a ON a.user_id = u.id
    WHERE u.role = 'analyst'`, [OPEN]);
  const stats = await c.query(`
    SELECT assignee_id, category, count(*)::int AS done, count(*) FILTER (WHERE closed_on_time)::int AS "onTime"
    FROM tasks WHERE status = 'done' AND assignee_id IS NOT NULL GROUP BY 1, 2`);
  for (const a of rows) {
    a.categoryStats = {};
    for (const s of stats.rows) if (s.assignee_id === a.id) a.categoryStats[s.category] = { done: s.done, onTime: s.onTime };
  }
  return rows;
}

async function getTask(c, id, { lock = false } = {}) {
  const { rows } = await c.query(`SELECT * FROM tasks WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw new HttpError(404, 'That task doesn’t exist.');
  return rows[0];
}

// Analysts whose decline on this task was accepted, so it isn't offered to them again.
async function decliners(c, taskId) {
  const { rows } = await c.query(
    "SELECT analyst_id FROM task_requests WHERE task_id = $1 AND kind = 'decline' AND status = 'approved'", [taskId]);
  return rows.map((r) => r.analyst_id);
}

// ---- Writes shared by several actions ----

const logEvent = (c, e) => c.query(
  'INSERT INTO task_events (task_id, actor_id, analyst_id, type, note, score_delta) VALUES ($1, $2, $3, $4, $5, $6)',
  [e.taskId, e.actorId || null, e.analystId || null, e.type, e.note || null, e.scoreDelta == null ? null : e.scoreDelta]);

const notice = (c, taskId, message) => c.query('INSERT INTO notices (task_id, message) VALUES ($1, $2)', [taskId, message]);

// Applies a trust score change and records the change that actually happened.
async function adjustScore(c, { analystId, taskId, delta, type, note, actorId }) {
  if (!delta) return logEvent(c, { taskId, actorId, analystId, type, note, scoreDelta: 0 });
  const { rows } = await c.query('SELECT trust_score::float AS s FROM analysts WHERE user_id = $1 FOR UPDATE', [analystId]);
  if (!rows[0]) return logEvent(c, { taskId, actorId, analystId, type, note });
  const next = A.applyScore(rows[0].s, delta);
  await c.query('UPDATE analysts SET trust_score = $2 WHERE user_id = $1', [analystId, next]);
  return logEvent(c, { taskId, actorId, analystId, type, note, scoreDelta: Math.round((next - rows[0].s) * 10) / 10 });
}

async function assignTo(c, task, analystId, { by, actorId, dueAt, dueReason, override = false, note }) {
  await c.query(`
    UPDATE tasks SET assignee_id = $2, status = 'assigned', assigned_by = $3, tier_override = $4,
           due_at = $5, due_reason = $6, queued_at = NULL WHERE id = $1`,
  [task.id, analystId, by, override, dueAt, dueReason || null]);
  await c.query('UPDATE analysts SET last_assigned_at = now() WHERE user_id = $1', [analystId]);
  await logEvent(c, { taskId: task.id, actorId, analystId, type: 'assigned', note });
}

// Where step 5 plugs in the AI: return { at, reason } for the task, or null to use the default.
// Whatever comes back is clamped to sane bounds for the priority.
async function proposeDueDate(/* task */) { return null; }

// Gives a High task to the best free Senior analyst, or queues it and tells the execs.
async function autoAssign(c, task, { fallback = false } = {}) {
  const pick = A.pickAutoAssignee(task, await loadAnalysts(c), { fallback, exclude: await decliners(c, task.id) });
  if (!pick) {
    if (task.status !== 'queued') {
      await c.query("UPDATE tasks SET status = 'queued', assignee_id = NULL, queued_at = now() WHERE id = $1", [task.id]);
      await logEvent(c, { taskId: task.id, type: 'queued', note: 'No Senior analyst is free.' });
      await notice(c, task.id, `“${task.title}” is High priority but no Senior analyst is free. It’s queued and will be assigned when someone frees up.`);
    }
    return null;
  }
  let proposal = null;
  try { proposal = await proposeDueDate(task); } catch (err) { console.error('AI due date failed:', err.message); }
  const dueAt = A.clampDueAt(task.priority, proposal && proposal.at);
  const dueReason = proposal ? proposal.reason : `Default ${A.SUGGESTED_DUE_DAYS[task.priority]}-day deadline for ${task.priority} priority.`;
  const note = pick.fellBack ? 'Auto-assigned to a Mid analyst after no Senior freed up.' : 'Auto-assigned.';
  await assignTo(c, task, pick.analyst.id, { by: 'auto', dueAt, dueReason, override: pick.fellBack, note });
  if (pick.fellBack) await notice(c, task.id, `No Senior analyst freed up, so “${task.title}” went to ${pick.analyst.name} (Mid tier).`);
  return pick.analyst;
}

// Tries every queued High task again, oldest first. Run after anything that frees an analyst, and on a timer.
async function drainQueue() {
  const { rows } = await pool.query("SELECT id FROM tasks WHERE status = 'queued' ORDER BY queued_at");
  for (const { id } of rows) {
    await withTx(async (c) => {
      const { rows: t } = await c.query("SELECT * FROM tasks WHERE id = $1 AND status = 'queued' FOR UPDATE SKIP LOCKED", [id]);
      if (!t[0]) return;
      const waited = Date.now() - new Date(t[0].queued_at).getTime();
      await autoAssign(c, t[0], { fallback: waited >= A.FALLBACK_WAIT_MS });
    });
  }
}

const drainSoon = () => drainQueue().catch((err) => console.error('Could not process the task queue:', err));

// ---- Actions ----

async function createTask(user, body) {
  requireExec(user);
  const title = String(body.title || '').trim();
  const priority = body.priority;
  if (!title) throw new HttpError(400, 'Give the task a title.');
  if (!A.PRIORITIES.includes(priority)) throw new HttpError(400, 'Priority must be High, Medium or Low.');
  return withTx(async (c) => {
    const { rows } = await c.query(`
      INSERT INTO tasks (title, description, category, source_ref, priority, created_by)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [title, body.description || null, body.category || 'general', body.sourceRef || null, priority, user.id]);
    const task = rows[0];
    await logEvent(c, { taskId: task.id, actorId: user.id, type: 'created' });
    if (priority === 'High') await autoAssign(c, task);
    return getTask(c, task.id);
  });
}

async function listTasks(user, { status } = {}) {
  const where = [];
  const args = [];
  if (!isExec(user)) { args.push(user.id); where.push(`t.assignee_id = $${args.length}`); }
  if (status) { args.push(status); where.push(`t.status = $${args.length}`); }
  const { rows } = await pool.query(`
    SELECT t.*, u.name AS assignee_name,
           (SELECT json_agg(r ORDER BY r.created_at) FROM task_requests r WHERE r.task_id = t.id AND r.status = 'pending') AS pending_requests
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE t.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, t.created_at`, args);
  return rows;
}

async function taskDetail(user, id) {
  const task = await getTask(pool, id);
  if (!isExec(user) && task.assignee_id !== user.id) throw new HttpError(404, 'That task doesn’t exist.');
  const events = await pool.query(`
    SELECT e.*, a.name AS actor_name FROM task_events e LEFT JOIN users a ON a.id = e.actor_id
    WHERE e.task_id = $1 ORDER BY e.created_at`, [id]);
  const requests = await pool.query('SELECT * FROM task_requests WHERE task_id = $1 ORDER BY created_at', [id]);
  return { task, events: events.rows, requests: requests.rows };
}

// Ranked analysts for the exec's assign dialog, with a warning on anyone below the needed tier.
async function recommendations(user, id) {
  requireExec(user);
  const task = await getTask(pool, id);
  const declined = await decliners(pool, id);
  const ranked = A.rankAnalysts(task, await loadAnalysts(pool)).map((a) => ({
    id: a.id, name: a.name, trustScore: a.trustScore, tier: a.tier, openTasks: a.openTasks, maxOpenTasks: a.maxOpenTasks,
    available: a.available, eligible: a.eligible, categoryRate: Math.round(a.categoryRate * 100) / 100,
    profileSummary: a.profileSummary, declined: declined.includes(a.id), warning: A.overrideWarning(task, a),
  }));
  return { task, suggestedDueAt: A.suggestedDueAt(task.priority), recommended: ranked.filter((a) => a.eligible && a.available && !a.declined).slice(0, 3), analysts: ranked };
}

async function assignManual(user, id, body) {
  requireExec(user);
  const analystId = Number(body.analystId);
  const r = await withTx(async (c) => {
    const task = await getTask(c, id, { lock: true });
    if (task.status === 'done' || task.status === 'cancelled') throw new HttpError(409, 'That task is already closed.');
    const analyst = (await loadAnalysts(c)).find((a) => a.id === analystId);
    if (!analyst) throw new HttpError(400, 'Pick an analyst.');
    const warning = A.overrideWarning(task, analyst);
    if (warning && !body.confirmOverride) throw new HttpError(409, warning, { needsConfirm: true, warning });
    const dueAt = body.dueAt ? new Date(body.dueAt) : A.suggestedDueAt(task.priority);
    if (Number.isNaN(dueAt.getTime())) throw new HttpError(400, 'That due date isn’t valid.');
    const previous = OPEN.includes(task.status) ? task.assignee_id : null;
    await assignTo(c, task, analyst.id, { by: 'exec', actorId: user.id, dueAt, override: Boolean(warning), note: warning ? `Assigned below tier: ${warning}` : null });
    return { task: await getTask(c, id), freed: previous && previous !== analyst.id };
  });
  if (r.freed) drainSoon();
  return r.task;
}

// Loads a task the logged-in analyst holds, for the analyst-side actions.
async function ownTask(c, user, id, statuses = OPEN) {
  const task = await getTask(c, id, { lock: true });
  if (task.assignee_id !== user.id) throw new HttpError(404, 'That task doesn’t exist.');
  if (!statuses.includes(task.status)) throw new HttpError(409, 'You can’t do that with this task right now.');
  return task;
}

const accept = (user, id) => withTx(async (c) => {
  await ownTask(c, user, id, ['assigned']);
  await c.query("UPDATE tasks SET status = 'accepted' WHERE id = $1", [id]);
  await logEvent(c, { taskId: id, actorId: user.id, analystId: user.id, type: 'accepted' });
  return getTask(c, id);
});

const clarify = (user, id, body) => withTx(async (c) => {
  const message = String(body.message || '').trim();
  if (!message) throw new HttpError(400, 'Write your question.');
  const task = await ownTask(c, user, id);
  await logEvent(c, { taskId: id, actorId: user.id, analystId: user.id, type: 'clarify', note: message });
  await notice(c, id, `${user.name} has a question about “${task.title}”: ${message}`);
  return getTask(c, id);
});

const PRIORITY_UP = { Low: 'Medium', Medium: 'High' };

// The analyst says it's harder than its priority suggests: priority goes up one level.
async function escalate(user, id, body) {
  const reason = String(body.reason || '').trim();
  if (!reason) throw new HttpError(400, 'Say why this needs escalating.');
  return withTx(async (c) => {
    const task = await ownTask(c, user, id);
    const next = PRIORITY_UP[task.priority];
    if (next) await c.query('UPDATE tasks SET priority = $2 WHERE id = $1', [id, next]);
    await logEvent(c, { taskId: id, actorId: user.id, analystId: user.id, type: 'escalated', note: reason });
    const analyst = (await loadAnalysts(c)).find((a) => a.id === user.id);
    const outOfTier = next && analyst && !A.canHandle(analyst.trustScore, next);
    await notice(c, id, `${user.name} escalated “${task.title}”${next ? ` to ${next} priority` : ''}: ${reason}${outOfTier ? ' It’s now above their tier, so consider reassigning it.' : ''}`);
    return getTask(c, id);
  });
}

async function requestExtension(user, id, body) {
  const reason = String(body.reason || '').trim();
  const proposed = new Date(body.proposedDueAt);
  if (!reason) throw new HttpError(400, 'Say why you need more time.');
  if (Number.isNaN(proposed.getTime()) || proposed <= new Date()) throw new HttpError(400, 'Pick a new due date in the future.');
  return withTx(async (c) => {
    const task = await ownTask(c, user, id);
    await noPending(c, id, 'extension');
    await c.query(`INSERT INTO task_requests (task_id, analyst_id, kind, reason, proposed_due_at)
                   VALUES ($1, $2, 'extension', $3, $4)`, [id, user.id, reason, proposed]);
    const late = task.due_at && new Date(task.due_at) < new Date();
    await adjustScore(c, { analystId: user.id, taskId: id, delta: late ? A.SCORE.lateExtension : 0, type: 'extension_requested', note: reason, actorId: user.id });
    await notice(c, id, `${user.name} asked for more time on “${task.title}”: ${reason}`);
    return getTask(c, id);
  });
}

async function decline(user, id, body) {
  const category = body.category;
  const reason = String(body.reason || '').trim();
  if (!A.DECLINE_REASONS[category]) throw new HttpError(400, `Pick a reason: ${Object.values(A.DECLINE_REASONS).join(', ')}.`);
  if (reason.length < 10) throw new HttpError(400, 'Explain your reason in a sentence or two.');
  return withTx(async (c) => {
    const task = await ownTask(c, user, id);
    await noPending(c, id, 'decline');
    await c.query(`INSERT INTO task_requests (task_id, analyst_id, kind, reason_category, reason)
                   VALUES ($1, $2, 'decline', $3, $4)`, [id, user.id, category, reason]);
    await logEvent(c, { taskId: id, actorId: user.id, analystId: user.id, type: 'decline_requested', note: `${A.DECLINE_REASONS[category]}: ${reason}` });
    await notice(c, id, `${user.name} wants to decline “${task.title}” (${A.DECLINE_REASONS[category]}): ${reason}`);
    return getTask(c, id);
  });
}

async function noPending(c, taskId, kind) {
  const { rows } = await c.query("SELECT 1 FROM task_requests WHERE task_id = $1 AND kind = $2 AND status = 'pending'", [taskId, kind]);
  if (rows[0]) throw new HttpError(409, `There’s already a ${kind} request waiting on this task.`);
}

// Exec approves or rejects a decline or extension request.
async function reviewRequest(user, requestId, body) {
  requireExec(user);
  const approve = Boolean(body.approve);
  const r = await withTx(async (c) => {
    const { rows } = await c.query("SELECT * FROM task_requests WHERE id = $1 AND status = 'pending' FOR UPDATE", [requestId]);
    const req = rows[0];
    if (!req) throw new HttpError(404, 'That request doesn’t exist or was already reviewed.');
    const task = await getTask(c, req.task_id, { lock: true });
    await c.query('UPDATE task_requests SET status = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1',
      [req.id, approve ? 'approved' : 'rejected', user.id]);
    const stillTheirs = task.assignee_id === req.analyst_id && OPEN.includes(task.status);

    if (req.kind === 'extension') {
      if (approve && stillTheirs) await c.query('UPDATE tasks SET due_at = $2 WHERE id = $1', [task.id, req.proposed_due_at]);
      await logEvent(c, { taskId: task.id, actorId: user.id, analystId: req.analyst_id, type: approve ? 'extension_approved' : 'extension_rejected' });
      return { freed: false };
    }

    const { rows: recent } = await c.query(`
      SELECT count(*)::int AS n FROM task_requests
      WHERE analyst_id = $1 AND kind = 'decline' AND status = 'approved' AND id <> $2 AND created_at > now() - interval '30 days'`,
    [req.analyst_id, req.id]);
    const delta = A.declineDelta({ valid: approve, category: req.reason_category, recentValidDeclines: recent[0].n });
    await adjustScore(c, { analystId: req.analyst_id, taskId: task.id, delta, type: approve ? 'decline_approved' : 'decline_rejected', actorId: user.id });
    if (!approve || !stillTheirs) return { freed: false };

    await c.query("UPDATE tasks SET status = 'open', assignee_id = NULL, assigned_by = NULL, tier_override = false WHERE id = $1", [task.id]);
    if (task.priority === 'High') await autoAssign(c, { ...task, status: 'open' });
    else await notice(c, task.id, `“${task.title}” is unassigned again after a decline. Pick someone from the suggestions.`);
    return { freed: true };
  });
  if (r.freed) drainSoon();
  return taskDetail(user, (await pool.query('SELECT task_id FROM task_requests WHERE id = $1', [requestId])).rows[0].task_id);
}

async function complete(user, id) {
  const task = await withTx(async (c) => {
    const t = await ownTask(c, user, id);
    const onTime = !t.due_at || new Date() <= new Date(t.due_at);
    await c.query("UPDATE tasks SET status = 'done', closed_at = now(), closed_on_time = $2 WHERE id = $1", [id, onTime]);
    // Any request still waiting no longer matters.
    await c.query("UPDATE task_requests SET status = 'rejected', reviewed_at = now() WHERE task_id = $1 AND status = 'pending'", [id]);
    await adjustScore(c, { analystId: user.id, taskId: id, delta: A.completionDelta({ onTime }), type: 'completed', note: onTime ? 'On time.' : 'Late.', actorId: user.id });
    return getTask(c, id);
  });
  drainSoon();
  return task;
}

// Exec sends finished work back. Costs less if the exec assigned it below the analyst's tier.
async function reopen(user, id, body) {
  requireExec(user);
  return withTx(async (c) => {
    const task = await getTask(c, id, { lock: true });
    if (task.status !== 'done' || !task.assignee_id) throw new HttpError(409, 'Only finished tasks can be reopened.');
    await c.query("UPDATE tasks SET status = 'assigned', closed_at = NULL, closed_on_time = NULL WHERE id = $1", [id]);
    await adjustScore(c, { analystId: task.assignee_id, taskId: id, delta: A.reopenDelta({ overridden: task.tier_override }), type: 'reopened', note: body.reason || null, actorId: user.id });
    return getTask(c, id);
  });
}

async function listAnalysts(user) {
  requireExec(user);
  return (await loadAnalysts(pool)).map((a) => ({ ...a, tier: A.tierOf(a.trustScore).name, available: A.isAvailable(a) }));
}

async function setRole(user, userId, body) {
  if (user.role !== 'admin') throw new HttpError(403, 'Only an admin can change roles.');
  const role = body.role;
  if (!['admin', 'exec', 'analyst'].includes(role)) throw new HttpError(400, 'Role must be admin, exec or analyst.');
  return withTx(async (c) => {
    const { rows } = await c.query('SELECT id, role FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!rows[0]) throw new HttpError(404, 'That person doesn’t exist.');
    if (rows[0].role === 'analyst' && role !== 'analyst') {
      const open = await c.query('SELECT 1 FROM tasks WHERE assignee_id = $1 AND status = ANY($2) LIMIT 1', [userId, OPEN]);
      if (open.rows[0]) throw new HttpError(409, 'Reassign their open tasks first.');
    }
    await c.query('UPDATE users SET role = $2 WHERE id = $1', [userId, role]);
    if (role === 'analyst') await c.query('INSERT INTO analysts (user_id, trust_score) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, A.START_SCORE]);
    return { id: Number(userId), role };
  });
}

async function listNotices(user) {
  requireExec(user);
  const { rows } = await pool.query('SELECT * FROM notices WHERE read_at IS NULL ORDER BY created_at DESC LIMIT 100');
  return rows;
}

async function markNoticeRead(user, id) {
  requireExec(user);
  await pool.query('UPDATE notices SET read_at = now() WHERE id = $1', [id]);
  return { ok: true };
}

module.exports = {
  HttpError, drainQueue,
  createTask, listTasks, taskDetail, recommendations, assignManual,
  accept, clarify, escalate, requestExtension, decline, reviewRequest, complete, reopen,
  listAnalysts, setRole, listNotices, markNoticeRead,
};
