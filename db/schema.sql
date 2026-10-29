-- Verdict database schema. Safe to run more than once.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One account per email, ignoring upper/lower case.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

-- Login sessions (used by connect-pg-simple).
CREATE TABLE IF NOT EXISTS session (
  sid    VARCHAR      NOT NULL PRIMARY KEY,
  sess   JSON         NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);

-- ---- Analyst ranking and task assignment ----

-- admin and exec assign work; analysts do it. Existing accounts become admins.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';
-- New sign-ups get 'member' (no access to tasks) until an admin gives them a role.
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'member';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'exec', 'analyst', 'member'));

-- One row per analyst. Created when someone is given the analyst role.
CREATE TABLE IF NOT EXISTS analysts (
  user_id            INTEGER     PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  trust_score        NUMERIC(4,1) NOT NULL DEFAULT 50 CHECK (trust_score BETWEEN 0 AND 100),
  max_open_tasks     INTEGER     NOT NULL DEFAULT 5 CHECK (max_open_tasks > 0),
  last_assigned_at   TIMESTAMPTZ,
  profile_summary    TEXT,        -- written by AI from past tasks
  profile_updated_at TIMESTAMPTZ
);

-- Work items from Needs attention.
CREATE TABLE IF NOT EXISTS tasks (
  id               SERIAL      PRIMARY KEY,
  title            TEXT        NOT NULL,
  description      TEXT,
  category         TEXT        NOT NULL DEFAULT 'general', -- e.g. approval, usage_slipping, cost_overrun
  source_ref       TEXT,                                  -- the Needs attention item it came from
  priority         TEXT        NOT NULL CHECK (priority IN ('High', 'Medium', 'Low')),
  status           TEXT        NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'queued', 'assigned', 'accepted', 'done', 'cancelled')),
  assignee_id      INTEGER     REFERENCES users (id) ON DELETE SET NULL,
  assigned_by      TEXT        CHECK (assigned_by IN ('auto', 'exec')),
  tier_override    BOOLEAN     NOT NULL DEFAULT false,    -- exec assigned below the needed tier
  due_at           TIMESTAMPTZ,
  due_reason       TEXT,
  queued_at        TIMESTAMPTZ,
  created_by       INTEGER     REFERENCES users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at        TIMESTAMPTZ,
  closed_on_time   BOOLEAN
);

-- Why the assignee got this task: typed by the exec, or written by auto-delegation.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assign_reason TEXT;

CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (assignee_id) WHERE status IN ('assigned', 'accepted');
CREATE INDEX IF NOT EXISTS tasks_queue_idx ON tasks (queued_at) WHERE status = 'queued';

-- Everything that happens to a task. Trust score changes are recorded here with score_delta.
CREATE TABLE IF NOT EXISTS task_events (
  id          SERIAL      PRIMARY KEY,
  task_id     INTEGER     NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  actor_id    INTEGER     REFERENCES users (id) ON DELETE SET NULL, -- null = the system
  analyst_id  INTEGER     REFERENCES users (id) ON DELETE SET NULL,
  type        TEXT        NOT NULL, -- created, assigned, accepted, clarify, escalated, completed, reopened...
  note        TEXT,
  score_delta NUMERIC(4,1),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id);

-- Declines and deadline extensions waiting for an exec's decision.
CREATE TABLE IF NOT EXISTS task_requests (
  id              SERIAL      PRIMARY KEY,
  task_id         INTEGER     NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  analyst_id      INTEGER     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind            TEXT        NOT NULL CHECK (kind IN ('decline', 'extension')),
  reason_category TEXT,
  reason          TEXT        NOT NULL,
  proposed_due_at TIMESTAMPTZ,
  status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by     INTEGER     REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Alerts for execs, e.g. a High task that couldn't be auto-assigned.
CREATE TABLE IF NOT EXISTS notices (
  id         SERIAL      PRIMARY KEY,
  task_id    INTEGER     REFERENCES tasks (id) ON DELETE CASCADE,
  message    TEXT        NOT NULL,
  kind       TEXT,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What a notice is about: question and escalated go in the exec's requests inbox, the rest are alerts.
ALTER TABLE notices ADD COLUMN IF NOT EXISTS kind TEXT;
UPDATE notices SET kind = CASE
    WHEN message LIKE '% has a question about %' THEN 'question'
    WHEN message LIKE '% escalated “%' THEN 'escalated'
    WHEN message LIKE '% asked for more time on %' THEN 'extension'
    WHEN message LIKE '% wants to decline “%' THEN 'decline'
    ELSE 'alert' END
  WHERE kind IS NULL;
