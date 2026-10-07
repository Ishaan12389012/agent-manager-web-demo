// Verdict web server: serves the app, plus sign up / log in backed by PostgreSQL.
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { pool } = require('./db/pool');

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
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

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
        'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
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
    const { rows } = await pool.query('SELECT id, name, email, password_hash FROM users WHERE lower(email) = $1', [email]);
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
    const { rows } = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.session.userId]);
    if (!rows[0]) return res.status(401).json({ error: 'Not logged in.' });
    res.json({ user: publicUser(rows[0]) });
  } catch (err) { next(err); }
});

// ---- Pages ----

const page = (file) => path.join(__dirname, 'public', file);
const loggedIn = (req) => Boolean(req.session.userId);

app.get('/login', (req, res) => (loggedIn(req) ? res.redirect('/') : res.sendFile(page('login.html'))));
app.get('/signup', (req, res) => (loggedIn(req) ? res.redirect('/') : res.sendFile(page('signup.html'))));
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

// The app itself is only for logged-in people.
app.get(['/', '/index.html'], (req, res) => (loggedIn(req) ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

app.listen(PORT, () => console.log(`Verdict is running at http://localhost:${PORT}`));
