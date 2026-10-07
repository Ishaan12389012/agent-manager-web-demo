# Verdict

See what every AI tool and agent in the company costs, returns and needs from you.

The app now has accounts: people sign up and log in, and their details are stored in PostgreSQL.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer and a PostgreSQL database.

1. **Get a database.** Either install PostgreSQL locally and create a database (`createdb verdict`), or make a free one on a host like [Neon](https://neon.tech), [Supabase](https://supabase.com) or [Render](https://render.com) and copy its connection string.
2. **Install the packages:** `npm install`
3. **Add your settings:** copy `.env.example` to `.env`, then put your connection string in `DATABASE_URL` and any long random text in `SESSION_SECRET`. For a hosted database, also set `DATABASE_SSL=true`.
4. **Create the tables:** `npm run db:setup` (safe to run again; it skips tables that already exist)
5. **Start the site:** `npm start`, then open http://localhost:3000

You'll land on the log in page. Click **Create an account**, and you're in. **Sign out** is in the account menu at the top right.

## What's where

| File | What it does |
| --- | --- |
| `index.html` | The Verdict app (only shown to logged-in people) |
| `public/login.html`, `public/signup.html` | Log in and sign up pages |
| `server.js` | Web server: pages plus `/api/signup`, `/api/login`, `/api/logout`, `/api/me` |
| `db/schema.sql` | The `users` and `session` tables |
| `db/setup.js` | Runs the schema against `DATABASE_URL` |

Passwords are hashed with bcrypt and never stored as plain text. Logins are kept in a cookie-based session stored in Postgres, so people stay logged in for a week, even across server restarts.

Opening `index.html` directly in a browser still works as a standalone demo (as the sample user, with no login).
