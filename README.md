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

## Put it online (Render)

`render.yaml` sets the site up on [Render](https://render.com)'s free plan, so anyone can open it at a public link.

1. In Render, choose **New > Blueprint** and pick this repository.
2. When asked, paste your database connection string into `DATABASE_URL`. Render fills in the rest itself, including a random `SESSION_SECRET`.
3. Click **Apply**. Every time `main` changes on GitHub, Render rebuilds the site.

### Who can do what

Every account has a role: **admin** (assigns work and changes roles), **exec** (assigns work), **analyst** (works on tasks given to them) or **no access yet**. The first account ever created is an admin. Everyone who signs up after that starts with no access until an admin gives them a role in **Settings > Manage users**. Accounts that existed before roles were added are admins.

### Copilot Studio chatbot

Ask Verdict shows your Copilot Studio agent. To connect it, copy **Secret 1** from Copilot Studio (**Settings > Security > Web channel security**) into `COPILOT_DIRECTLINE_SECRET`, in `.env` on your computer or in the Render service's **Environment** tab. The secret stays on the server; the chat window only gets a short-lived token.

### Importing data

Open **Data** in the sidebar. Execs and admins can upload an Excel (`.xlsx`) or CSV file; each sheet becomes its own table (tables stacked on one sheet, separated by a blank row or a second header row, are split apart), stored in Postgres, and everyone with a role can view and search it. Re-uploading a file with the same name replaces the old copy, including removing tables that are no longer in it. The first row of each sheet should hold the column titles. Files can be up to 10 MB and 20,000 rows per sheet.

### Keeping a spreadsheet in sync

If the spreadsheet lives in OneDrive or SharePoint, Verdict can re-import it by itself when it changes. Set `EXCEL_SYNC_URL` to the file's share link (in `.env`, or the Render service's **Environment** tab). The server downloads the file every `EXCEL_SYNC_MINUTES` (default 5) and re-imports it when its contents change; tables that disappear from the file are removed. The Data page shows when it last checked, and execs and admins get a **Sync now** button.

- A link shared with **Anyone with the link** works with nothing else to set.
- For a work file that needs a sign-in, also set `MS_TENANT_ID`, `MS_CLIENT_ID` and `MS_CLIENT_SECRET` from a Microsoft Entra app registration with the Microsoft Graph **Files.Read.All** application permission (an admin grants consent).
- Or push the file instead: a Power Automate flow (*When a file is modified* → *Get file content* → *HTTP* POST to `/api/import/push?filename=<name>.xlsx` with the header `Authorization: Bearer <IMPORT_API_KEY>` and the file content as the body).

Free Render sites sleep when idle, so scheduled checks pause too; the first visit after that wakes the site and it checks the file straight away.

Free Render sites go to sleep after about 15 minutes with no visitors, and the first visit after that takes up to a minute to load.

## What's where

| File | What it does |
| --- | --- |
| `index.html` | The Verdict app (only shown to logged-in people) |
| `public/login.html`, `public/signup.html` | Log in and sign up pages |
| `server.js` | Web server: pages plus `/api/signup`, `/api/login`, `/api/logout`, `/api/me` |
| `db/schema.sql` | The `users` and `session` tables, plus analysts, tasks, task events, requests and notices |
| `lib/assign.js` | Analyst ranking, tiers and trust score rules (pure functions, tested in `lib/assign.test.js`, run with `npm test`) |
| `public/data.html`, `lib/importer.js`, `lib/datasets.js` | The Data page, the code that reads Excel and CSV files into tables (tested in `lib/importer.test.js`), and saving them, used by the `/api/datasets` and `/api/import/push` routes |
| `lib/excel-sync.js` | Keeps a OneDrive or SharePoint spreadsheet in sync (tested in `lib/excel-sync.test.js`) |
| `lib/tasks.js` | Task assignment against the database, used by the `/api/tasks`, `/api/requests`, `/api/analysts`, `/api/notices`, `/api/users` and `/api/users/:id/role` routes |
| `db/setup.js` | Runs the schema against `DATABASE_URL` |
| `render.yaml` | How Render builds and runs the site |

Passwords are hashed with bcrypt and never stored as plain text. Logins are kept in a cookie-based session stored in Postgres, so people stay logged in for a week, even across server restarts.

Opening `index.html` directly in a browser still works as a standalone demo (as the sample user, with no login).
