-- SeatRelay on-premise reference schema (plan §2.7), PostgreSQL 16.
--
-- Applied idempotently on every server start (src/main.ts `migrate()`), and once by the
-- postgres container's init hook. Every statement is `IF [NOT] EXISTS`, so re-running is a
-- no-op. A column added after the first release also gets an `ALTER TABLE … ADD COLUMN IF NOT
-- EXISTS` next to its table (CREATE TABLE IF NOT EXISTS never adds columns to an existing
-- table), so an existing `pgdata` volume is upgraded in place by the next server start.
--
-- Layout mirrors the DynamoDB single table (plan §2.3): live items (what the worker loads as
-- the snapshot) and history items live in different tables, so the snapshot query never grows
-- with the workshop's past. Storage never runs business logic: every rule lives in the engine.
--
-- Timestamps are `timestamptz`; the adapter reads/writes ISO-8601 UTC strings with millisecond
-- precision (CONVENTIONS §3). Ids are opaque text (UUID v4 in production).

-- ---------------------------------------------------------------- organisations (C7)

CREATE TABLE IF NOT EXISTS organizations (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  owner_user_id text NOT NULL,
  created_at    timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id   text NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id  text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS org_members_user_idx ON org_members (user_id);

-- Identity cache filled from verified ID tokens (email -> userId lookup for
-- POST /orgs/{orgId}/members by email). Not an authority: Keycloak is.
CREATE TABLE IF NOT EXISTS users (
  id           text PRIMARY KEY,
  email        text NOT NULL,
  name         text,
  last_seen_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));

-- ---------------------------------------------------------------- workshops (META item)

CREATE TABLE IF NOT EXISTS workshops (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES organizations (id),
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  -- engine-owned fields (written only by the worker commit, optimistic lock = version)
  status       text NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLING', 'CANCELLED')),
  mode         text NOT NULL CHECK (mode IN ('UNIFIED', 'PER_SESSION')),
  hold_seconds integer NOT NULL CHECK (hold_seconds >= 30),
  seq          integer NOT NULL DEFAULT 0,
  version      integer NOT NULL DEFAULT 0,
  next_due_at  timestamptz,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS workshops_org_idx ON workshops (org_id, created_at);
-- sparse "DUE" index for the sweep (plan §1.2)
CREATE INDEX IF NOT EXISTS workshops_due_idx ON workshops (next_due_at) WHERE next_due_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id          text PRIMARY KEY,
  workshop_id text NOT NULL REFERENCES workshops (id) ON DELETE CASCADE,
  title       text NOT NULL,
  starts_at   timestamptz NOT NULL,
  cutoff_at   timestamptz NOT NULL,
  capacity    integer NOT NULL CHECK (capacity >= 1),
  confirmed   integer NOT NULL DEFAULT 0 CHECK (confirmed >= 0),
  held        integer NOT NULL DEFAULT 0 CHECK (held >= 0),
  status      text NOT NULL CHECK (status IN ('OPEN', 'CANCELLING', 'CANCELLED'))
);
CREATE INDEX IF NOT EXISTS sessions_workshop_idx ON sessions (workshop_id, starts_at);

-- ---------------------------------------------------------------- registrations

-- Live registrations only (QUEUED | OFFERED | CONFIRMED). `scope_key` is core's
-- `registrationScopeKey`: userId in UNIFIED mode, userId#sessionId in PER_SESSION mode, so the
-- unique index enforces R1 per (workshop, user) or per (workshop, user, session) respectively.
CREATE TABLE IF NOT EXISTS registrations (
  workshop_id          text NOT NULL REFERENCES workshops (id) ON DELETE CASCADE,
  seq                  integer NOT NULL CHECK (seq >= 1),
  user_id              text NOT NULL,
  email                text NOT NULL,
  display_name         text,
  acceptable           jsonb NOT NULL,
  status               text NOT NULL CHECK (status IN ('QUEUED', 'OFFERED', 'CONFIRMED')),
  end_reason           text,
  current_offer_id     text,
  confirmed_session_id text,
  scope_key            text NOT NULL,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  PRIMARY KEY (workshop_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS registrations_r1_idx ON registrations (workshop_id, scope_key);
CREATE INDEX IF NOT EXISTS registrations_user_idx ON registrations (user_id);

CREATE TABLE IF NOT EXISTS registrations_history (
  workshop_id          text NOT NULL REFERENCES workshops (id) ON DELETE CASCADE,
  seq                  integer NOT NULL,
  user_id              text NOT NULL,
  email                text NOT NULL,
  display_name         text,
  acceptable           jsonb NOT NULL,
  status               text NOT NULL CHECK (status IN ('CANCELLED', 'ENDED')),
  end_reason           text,
  current_offer_id     text,
  confirmed_session_id text,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  archived_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workshop_id, seq)
);
CREATE INDEX IF NOT EXISTS registrations_history_user_idx ON registrations_history (user_id);

-- ---------------------------------------------------------------- offers

-- Live offers only (status OFFERED). One live offer per registration (C2).
CREATE TABLE IF NOT EXISTS offers (
  id               text PRIMARY KEY,
  workshop_id      text NOT NULL REFERENCES workshops (id) ON DELETE CASCADE,
  session_id       text NOT NULL,
  user_id          text NOT NULL,
  registration_seq integer NOT NULL,
  status           text NOT NULL CHECK (status = 'OFFERED'),
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  settled_at       timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS offers_registration_idx ON offers (workshop_id, registration_seq);
CREATE INDEX IF NOT EXISTS offers_workshop_idx ON offers (workshop_id);

CREATE TABLE IF NOT EXISTS offers_history (
  id               text PRIMARY KEY,
  workshop_id      text NOT NULL REFERENCES workshops (id) ON DELETE CASCADE,
  session_id       text NOT NULL,
  user_id          text NOT NULL,
  registration_seq integer NOT NULL,
  status           text NOT NULL CHECK (status IN ('ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED')),
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  settled_at       timestamptz,
  archived_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offers_history_workshop_idx ON offers_history (workshop_id);

-- ---------------------------------------------------------------- backfill records

-- `pending` = still waiting for a taker while a REALLOCATE continuation is in flight (a live
-- item of the snapshot, core `PUT_PENDING_BACKFILL`); ARCHIVE_BACKFILL / PUT_BACKFILL clear it.
CREATE TABLE IF NOT EXISTS backfill_records (
  id             text PRIMARY KEY,
  workshop_id    text NOT NULL REFERENCES workshops (id) ON DELETE CASCADE,
  session_id     text NOT NULL,
  released_at    timestamptz NOT NULL,
  cause          text NOT NULL CHECK (cause IN ('EXPIRED', 'DECLINED', 'CANCELLED_CONFIRMED', 'CANCELLED_OFFER', 'CAPACITY_UP', 'SESSION_CANCELLED')),
  reallocated_at timestamptz,
  new_offer_id   text,
  new_user_id    text,
  latency_ms     integer,
  pending        boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS backfill_records_workshop_idx ON backfill_records (workshop_id, released_at);
CREATE INDEX IF NOT EXISTS backfill_records_pending_idx ON backfill_records (workshop_id) WHERE pending;

-- ---------------------------------------------------------------- command results (plan §1.3)

CREATE TABLE IF NOT EXISTS command_results (
  command_id    text PRIMARY KEY,
  type          text NOT NULL,
  actor_user_id text NOT NULL,
  workshop_id   text NOT NULL,
  status        text NOT NULL CHECK (status IN ('ACCEPTED', 'APPLIED', 'REJECTED')),
  reason        text,
  result        jsonb,
  accepted_at   timestamptz NOT NULL,
  settled_at    timestamptz,
  ttl           bigint NOT NULL,
  expires_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS command_results_expires_idx ON command_results (expires_at);
CREATE INDEX IF NOT EXISTS command_results_workshop_idx ON command_results (workshop_id, accepted_at);

-- ---------------------------------------------------------------- notifications

CREATE TABLE IF NOT EXISTS notifications (
  id          text PRIMARY KEY,
  user_id     text NOT NULL,
  email       text NOT NULL,
  workshop_id text NOT NULL,
  kind        text NOT NULL,
  offer_id    text,
  title       text NOT NULL,
  body        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL,
  read_at     timestamptz,
  sent_at     timestamptz,
  ttl         bigint NOT NULL,
  expires_at  timestamptz NOT NULL,
  -- earliest time the notifier may (re)try the e-mail: insert time, then exponential backoff
  -- after each failed send (src/notifier.ts)
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
-- upgrade of a table created before `next_attempt_at` existed (no-op on a fresh database)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
-- notifier poll: PENDING rows that are due (replaces the former notifications_pending_idx)
DROP INDEX IF EXISTS notifications_pending_idx;
CREATE INDEX IF NOT EXISTS notifications_due_idx ON notifications (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS notifications_expires_idx ON notifications (expires_at);

-- ---------------------------------------------------------------- attendance (API, synchronous)

CREATE TABLE IF NOT EXISTS attendance (
  workshop_id text NOT NULL REFERENCES workshops (id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  attended    boolean NOT NULL,
  marked_at   timestamptz NOT NULL,
  marked_by   text NOT NULL,
  PRIMARY KEY (workshop_id, user_id)
);

-- ---------------------------------------------------------------- command queue (FIFO per workshop)

-- The on-prem stand-in for `commands.fifo`: `id` is the arrival order, `dedup_id` the FIFO
-- deduplication id (commandId / tick#offerId#expiresAt), `available_at` the retry backoff.
CREATE TABLE IF NOT EXISTS commands (
  id           bigserial PRIMARY KEY,
  workshop_id  text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE', 'FAILED')),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  dedup_id     text UNIQUE,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz
);
-- worker poll: PENDING rows by availability then arrival
CREATE INDEX IF NOT EXISTS commands_poll_idx ON commands (available_at, id) WHERE status = 'PENDING';
-- per-workshop head-of-line check (strict FIFO per workshop even with several workers)
CREATE INDEX IF NOT EXISTS commands_workshop_pending_idx ON commands (workshop_id, id) WHERE status = 'PENDING';

-- ---------------------------------------------------------------- expiry timers (plan §1.2)

-- One row per new offer (the stand-in for the `expiry-delay` queue); the timer loop turns
-- due rows into TICK commands and marks them fired.
CREATE TABLE IF NOT EXISTS timers (
  id          bigserial PRIMARY KEY,
  workshop_id text NOT NULL,
  offer_id    text NOT NULL,
  fire_at     timestamptz NOT NULL,
  fired       boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  fired_at    timestamptz
);
CREATE INDEX IF NOT EXISTS timers_due_idx ON timers (fire_at) WHERE NOT fired;
