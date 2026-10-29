// Verdict web server: serves the app, plus sign up / log in backed by PostgreSQL.
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { pool } = require('./db/pool');
const tasks = require('./lib/tasks');
const importer = require('./lib/importer');

const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

if (!process.env.SESSION_SECRET) {
  if (isProd) {
    console.error('SESSION_SECRET is not set. Add a long random value to your environment.');
    process.exit(1);
  }
  console.warn('SESSION_SECRET is not set; using an insecure development value.');
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// Lets the host check the site is up.
app.get('/healthz', (req, res) => res.send('ok'));

app.use(session({
  store: new PgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  name: 'verdict.sid',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000 * 60 * 60 * 24 * 7 },
}));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

// Swap the session id on login so an old cookie can't be reused.
const startSession = (req, userId) => new Promise((resolve, reject) => {
  req.session.regenerate((err) => {
    if (err) return reject(err);
    req.session.userId = userId;
    req.session.save((e) => (e ? reject(e) : resolve()));
  });
});

// ---- API ----

app.post('/api/signup', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!name) return res.status(400).json({ error: 'Enter your name.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Use at least 8 characters for your password.' });

    const hash = await bcrypt.hash(password, 12);
    let user;
    try {
      const { rows } = await pool.query(
        // The very first account is the admin; everyone after waits for an admin to give them a role.
        `INSERT INTO users (name, email, password_hash, role)
         VALUES ($1, $2, $3, CASE WHEN EXISTS (SELECT 1 FROM users WHERE role = 'admin') THEN 'member' ELSE 'admin' END)
         RETURNING id, name, email, role`,
        [name, email, hash],
      );
      user = rows[0];
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'An account with that email already exists. Try logging in.' });
      throw err;
    }

    await startSession(req, user.id);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) { next(err); }
});

app.post('/api/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const { rows } = await pool.query('SELECT id, name, email, role, password_hash FROM users WHERE lower(email) = $1', [email]);
    const user = rows[0];
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) return res.status(401).json({ error: 'That email and password don’t match.' });

    await startSession(req, user.id);
    res.json({ user: publicUser(user) });
  } catch (err) { next(err); }
});

app.post('/api/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('verdict.sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', async (req, res, next) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const { rows } = await pool.query('SELECT id, name, email, role FROM users WHERE id = $1', [req.session.userId]);
    if (!rows[0]) return res.status(401).json({ error: 'Not logged in.' });
    res.json({ user: publicUser(rows[0]) });
  } catch (err) { next(err); }
});

// ---- Tasks and analyst assignment ----
// The rules are in lib/assign.js; lib/tasks.js applies them to the database.

// Loads the logged-in person (with their role) onto req.user.
const requireUser = async (req, res, next) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const { rows } = await pool.query('SELECT id, name, email, role FROM users WHERE id = $1', [req.session.userId]);
    if (!rows[0]) return res.status(401).json({ error: 'Not logged in.' });
    req.user = rows[0];
    next();
  } catch (err) { next(err); }
};

// Wraps a lib/tasks.js action as a route handler.
const act = (fn) => async (req, res, next) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof tasks.HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    next(err);
  }
};

app.use(['/api/tasks', '/api/requests', '/api/analysts', '/api/notices', '/api/users'], requireUser);

app.get('/api/tasks', act((req) => tasks.listTasks(req.user, { status: req.query.status })));
app.post('/api/tasks', act((req) => tasks.createTask(req.user, req.body)));
app.get('/api/tasks/:id', act((req) => tasks.taskDetail(req.user, req.params.id)));
app.get('/api/tasks/:id/recommendations', act((req) => tasks.recommendations(req.user, req.params.id)));
app.post('/api/tasks/:id/assign', act((req) => tasks.assignManual(req.user, req.params.id, req.body)));
app.post('/api/tasks/:id/accept', act((req) => tasks.accept(req.user, req.params.id)));
app.post('/api/tasks/:id/clarify', act((req) => tasks.clarify(req.user, req.params.id, req.body)));
app.post('/api/tasks/:id/escalate', act((req) => tasks.escalate(req.user, req.params.id, req.body)));
app.post('/api/tasks/:id/extension', act((req) => tasks.requestExtension(req.user, req.params.id, req.body)));
app.post('/api/tasks/:id/decline', act((req) => tasks.decline(req.user, req.params.id, req.body)));
app.post('/api/tasks/:id/complete', act((req) => tasks.complete(req.user, req.params.id)));
app.post('/api/tasks/:id/reopen', act((req) => tasks.reopen(req.user, req.params.id, req.body)));
app.post('/api/requests/:id/review', act((req) => tasks.reviewRequest(req.user, req.params.id, req.body)));
app.get('/api/analysts', act((req) => tasks.listAnalysts(req.user)));
app.get('/api/users', act((req) => tasks.listUsers(req.user)));
app.post('/api/users/:id/role', act((req) => tasks.setRole(req.user, req.params.id, req.body)));
app.get('/api/notices', act((req) => tasks.listNotices(req.user)));
app.post('/api/notices/:id/read', act((req) => tasks.markNoticeRead(req.user, req.params.id)));

// Retries queued High tasks every minute, falling back to Mid analysts once the wait window passes.
setInterval(() => tasks.drainQueue().catch((err) => console.error('Could not process the task queue:', err)), 60 * 1000).unref();

// ---- Imported data (Excel and CSV) ----
// Execs and admins upload a file; everyone with a role can view what was imported.
// The file is sent as the raw request body, with its name in ?filename=.

const canImport = (u) => u.role === 'admin' || u.role === 'exec';

app.use('/api/datasets', requireUser, (req, res, next) => (
  req.user.role === 'member' ? res.status(403).json({ error: 'Ask an admin to give you a role first.' }) : next()
));

app.get('/api/datasets', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT d.id, d.name, d.source_file AS "sourceFile", jsonb_array_length(d.columns) AS "columnCount",
             d.row_count AS "rowCount", d.imported_at AS "importedAt", u.name AS "importedBy"
      FROM datasets d LEFT JOIN users u ON u.id = d.imported_by ORDER BY d.imported_at DESC`);
    res.json({ datasets: rows, canImport: canImport(req.user) });
  } catch (err) { next(err); }
});

app.get('/api/datasets/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT d.id, d.name, d.source_file AS "sourceFile", d.columns, d.rows, d.row_count AS "rowCount",
             d.imported_at AS "importedAt", u.name AS "importedBy"
      FROM datasets d LEFT JOIN users u ON u.id = d.imported_by WHERE d.id = $1`, [Number(req.params.id) || 0]);
    if (!rows[0]) return res.status(404).json({ error: 'That table doesn’t exist.' });
    res.json({ dataset: rows[0] });
  } catch (err) { next(err); }
});

app.post('/api/datasets', express.raw({ type: () => true, limit: '10mb' }), async (req, res, next) => {
  try {
    if (!canImport(req.user)) return res.status(403).json({ error: 'Only an exec or admin can import data.' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Choose a file to import.' });
    const filename = String(req.query.filename || '').slice(0, 200);
    let tables;
    try { tables = await importer.readUpload(req.body, filename); } catch (err) {
      if (err instanceof importer.ImportError) return res.status(400).json({ error: err.message });
      throw err;
    }
    const saved = [];
    for (const t of tables) {
      const { rows } = await pool.query(`
        INSERT INTO datasets (name, source_file, columns, rows, row_count, imported_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT ((lower(name))) DO UPDATE SET name = EXCLUDED.name, source_file = EXCLUDED.source_file,
          columns = EXCLUDED.columns, rows = EXCLUDED.rows, row_count = EXCLUDED.row_count,
          imported_by = EXCLUDED.imported_by, imported_at = now()
        RETURNING id, name, row_count AS "rowCount"`,
        [t.name, filename, JSON.stringify(t.columns), JSON.stringify(t.rows), t.rows.length, req.user.id]);
      saved.push(rows[0]);
    }
    res.status(201).json({ imported: saved });
  } catch (err) { next(err); }
});

app.delete('/api/datasets/:id', async (req, res, next) => {
  try {
    if (!canImport(req.user)) return res.status(403).json({ error: 'Only an exec or admin can remove data.' });
    await pool.query('DELETE FROM datasets WHERE id = $1', [Number(req.params.id) || 0]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- Copilot Studio chatbot (Direct Line) ----
// The Direct Line secret stays on the server. Logged-in people get a short-lived
// token instead, which the chat window uses to talk to the Copilot Studio agent.
const DIRECTLINE_URL = (process.env.COPILOT_DIRECTLINE_URL || 'https://directline.botframework.com').replace(/\/+$/, '');

app.get('/api/copilot/token', async (req, res, next) => {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
    const secret = process.env.COPILOT_DIRECTLINE_SECRET;
    if (!secret) return res.status(503).json({ error: 'The chatbot is not connected yet.' });

    const r = await fetch(`${DIRECTLINE_URL}/v3/directline/tokens/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { id: `dl_verdict-${req.session.userId}` } }),
    });
    if (!r.ok) {
      console.error('Direct Line token request failed:', r.status, await r.text());
      return res.status(502).json({ error: 'Could not reach the chatbot. Please try again.' });
    }
    const { token } = await r.json();
    res.set('Cache-Control', 'no-store').json({ token, domain: `${DIRECTLINE_URL}/v3/directline` });
  } catch (err) { next(err); }
});

// ---- Pages ----

const page = (file) => path.join(__dirname, 'public', file);
const loggedIn = (req) => Boolean(req.session.userId);

app.get('/login', (req, res) => (loggedIn(req) ? res.redirect('/') : res.sendFile(page('login.html'))));
app.get('/signup', (req, res) => (loggedIn(req) ? res.redirect('/') : res.sendFile(page('signup.html'))));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

// Bot Framework Web Chat, the chat window Microsoft provides for Copilot Studio agents.
const webchatDist = path.join(__dirname, 'node_modules', 'botframework-webchat', 'dist');
app.get('/vendor/webchat.js', (req, res) => res.sendFile(path.join(webchatDist, 'webchat.js')));
app.get('/vendor/webchat.css', (req, res) => res.sendFile(path.join(webchatDist, 'webchat.css')));
app.get('/data', (req, res) => (loggedIn(req) ? res.sendFile(page('data.html')) : res.redirect('/login')));
app.get('/copilot-chat', (req, res) => (loggedIn(req) ? res.sendFile(page('copilot-chat.html')) : res.redirect('/login')));

// The app itself is only for logged-in people.
app.get(['/', '/index.html'], (req, res) => (loggedIn(req) ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

app.listen(PORT, () => console.log(`Verdict is running at http://localhost:${PORT}`));
