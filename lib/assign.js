// Analyst ranking and trust scoring. Pure functions only, no database, so they're easy to test.

const PRIORITIES = ['High', 'Medium', 'Low'];

// Tiers by trust score, highest first. Each tier can take the priorities listed.
const TIERS = [
  { name: 'Senior', min: 70, handles: ['High', 'Medium', 'Low'] },
  { name: 'Mid', min: 40, handles: ['Medium', 'Low'] },
  { name: 'Junior', min: 0, handles: ['Low'] },
];

const START_SCORE = 50;

// Days the exec is offered as a default due date. They can pick any date instead.
const SUGGESTED_DUE_DAYS = { High: 1, Medium: 3, Low: 7 };

// Limits for an AI-chosen due date, in hours, so an odd answer can't set a silly deadline.
const AI_DUE_BOUNDS_HOURS = { High: [4, 72], Medium: [24, 168], Low: [48, 336] };

// How long a High task waits for a Senior analyst before falling back to a Mid one.
const FALLBACK_WAIT_MS = 30 * 60 * 1000;

const SCORE = {
  doneOnTime: 3,
  doneLate: 1,
  reopened: -4,
  lateExtension: -1,
  declineRejected: -2,
  declinePattern: -1, // each valid decline after DECLINE_PATTERN_LIMIT in 30 days
  ratingStep: 2, // (rating - 3) * ratingStep for an optional 1-5 exec rating
};
const DECLINE_PATTERN_LIMIT = 3;

const DECLINE_REASONS = {
  outside_expertise: 'Outside my expertise',
  at_capacity: 'At capacity',
  conflict_of_interest: 'Conflict of interest',
  missing_information: 'Missing information',
  other: 'Other',
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const tierOf = (score) => TIERS.find((t) => score >= t.min);
const canHandle = (score, priority) => tierOf(score).handles.includes(priority);
const requiredTier = (priority) => TIERS.slice().reverse().find((t) => t.handles.includes(priority));
const isAvailable = (a) => a.openTasks < a.maxOpenTasks;

const suggestedDueAt = (priority, now = new Date()) => new Date(now.getTime() + SUGGESTED_DUE_DAYS[priority] * DAY);

// Keeps an AI-proposed due date inside the bounds for its priority. Falls back to the suggestion if it's unusable.
function clampDueAt(priority, proposed, now = new Date()) {
  const t = proposed ? new Date(proposed).getTime() : NaN;
  if (Number.isNaN(t)) return suggestedDueAt(priority, now);
  const [lo, hi] = AI_DUE_BOUNDS_HOURS[priority];
  return new Date(Math.min(Math.max(t, now.getTime() + lo * HOUR), now.getTime() + hi * HOUR));
}

// Success rate in one task category, smoothed so 1 of 1 doesn't beat 19 of 20.
function categoryRate(analyst, category) {
  const s = (analyst.categoryStats && analyst.categoryStats[category]) || { done: 0, onTime: 0 };
  return (s.onTime + 1) / (s.done + 2);
}

// Score changes shrink near the ends of the 0-100 range, so one bad week doesn't sink a top analyst.
function applyScore(score, delta) {
  const room = delta > 0 ? (100 - score) / 50 : score / 50;
  const next = score + delta * Math.min(1, room);
  return Math.round(Math.min(100, Math.max(0, next)) * 10) / 10;
}

// Score change when a task is closed. overridden = the exec assigned it below the needed tier.
function completionDelta({ onTime, rating }) {
  let d = onTime ? SCORE.doneOnTime : SCORE.doneLate;
  if (rating) d += (rating - 3) * SCORE.ratingStep;
  return d;
}

const reopenDelta = ({ overridden }) => (overridden ? SCORE.reopened / 2 : SCORE.reopened);

// Score change once the exec reviews a decline. recentValidDeclines excludes this one.
function declineDelta({ valid, category, recentValidDeclines }) {
  if (category === 'conflict_of_interest') return 0;
  if (!valid) return SCORE.declineRejected;
  return recentValidDeclines >= DECLINE_PATTERN_LIMIT ? SCORE.declinePattern : 0;
}

// Ranks analysts for a task. Order: fewest open tasks, trust score in bands of 10,
// success rate on this kind of task, then longest since their last assignment.
// Every analyst is returned with flags; callers filter on eligible / available.
function rankAnalysts(task, analysts, { exclude = [] } = {}) {
  return analysts
    .filter((a) => !exclude.includes(a.id))
    .map((a) => ({
      ...a,
      tier: tierOf(a.trustScore).name,
      eligible: canHandle(a.trustScore, task.priority),
      available: isAvailable(a),
      categoryRate: categoryRate(a, task.category),
    }))
    .sort((x, y) =>
      (y.eligible - x.eligible)
      || (y.available - x.available)
      || (x.openTasks - y.openTasks)
      || (Math.floor(y.trustScore / 10) - Math.floor(x.trustScore / 10))
      || (y.categoryRate - x.categoryRate)
      || (new Date(x.lastAssignedAt || 0) - new Date(y.lastAssignedAt || 0)));
}

// Who should get a High task automatically, or null to queue it.
// fallback = the wait window has passed, so the task must go to someone: a free Mid analyst,
// then a free Junior one, then whoever has the fewest open tasks even if they're full.
// candidates = the group the pick was made from, in rank order, for explaining the choice.
function pickAutoAssignee(task, analysts, { fallback = false, exclude = [] } = {}) {
  const ranked = rankAnalysts(task, analysts, { exclude });
  const free = ranked.filter((a) => a.available);
  const seniors = free.filter((a) => a.eligible);
  if (seniors.length) return { analyst: seniors[0], fellBack: false, overCapacity: false, candidates: seniors, group: 'free Senior analyst' };
  if (!fallback || !ranked.length) return null;
  const mids = free.filter((a) => a.tier === 'Mid');
  if (mids.length) return { analyst: mids[0], fellBack: true, overCapacity: false, candidates: mids, group: 'free Mid analyst' };
  if (free.length) return { analyst: free[0], fellBack: true, overCapacity: false, candidates: free, group: 'free analyst' };
  const busiest = ranked.slice().sort((x, y) => x.openTasks - y.openTasks || y.trustScore - x.trustScore);
  return { analyst: busiest[0], fellBack: true, overCapacity: true, candidates: busiest, group: 'analyst' };
}

// Plain-words reason shown to the analyst for why auto-delegation picked them.
// Follows the same order rankAnalysts sorts by, against the runner-up.
function autoReason(task, pick) {
  const a = pick.analyst, next = pick.candidates.find((x) => x.id !== a.id);
  const wait = Math.round(FALLBACK_WAIT_MS / 60000);
  const kind = (task.category || 'general').replace(/_/g, ' ');
  let why;
  if (!pick.fellBack) why = `you're a free Senior analyst (trust score ${a.trustScore}), the tier that handles ${task.priority} priority work`;
  else if (pick.overCapacity) why = `no one was free after ${wait} minutes, and you had the fewest open tasks`;
  else why = `no Senior analyst was free within ${wait} minutes, and you're a free ${a.tier} analyst (trust score ${a.trustScore})`;
  let edge;
  if (!next) edge = `You were the only ${pick.group}`;
  else if (a.openTasks < next.openTasks) edge = `You had the fewest open tasks (${a.openTasks} of ${a.maxOpenTasks})`;
  else if (Math.floor(a.trustScore / 10) > Math.floor(next.trustScore / 10)) edge = 'You had the highest trust score among those equally busy';
  else if (a.categoryRate > next.categoryRate) edge = `You have the best on-time record on ${kind} work`;
  else edge = 'You had gone longest without a new task';
  return pick.overCapacity ? `Auto-assigned because ${why}.` : `Auto-assigned because ${why}. ${edge}.`;
}

// Warning for an exec assigning below the tier a task usually needs, or null.
function overrideWarning(task, analyst) {
  if (canHandle(analyst.trustScore, task.priority)) return null;
  const tier = tierOf(analyst.trustScore).name;
  const need = requiredTier(task.priority).name;
  return `${analyst.name} is ${tier} tier (score ${analyst.trustScore}). This is a ${task.priority} priority task usually handled by ${need} analysts.`;
}

module.exports = {
  PRIORITIES, TIERS, START_SCORE, SUGGESTED_DUE_DAYS, AI_DUE_BOUNDS_HOURS, FALLBACK_WAIT_MS,
  SCORE, DECLINE_PATTERN_LIMIT, DECLINE_REASONS,
  tierOf, canHandle, requiredTier, isAvailable, suggestedDueAt, clampDueAt, categoryRate,
  applyScore, completionDelta, reopenDelta, declineDelta, rankAnalysts, pickAutoAssignee, autoReason, overrideWarning,
};
