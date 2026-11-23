-- Ivy - Postgres schema
-- Apply once via POST /api/admin/migrate with header x-admin-secret: $ADMIN_SECRET
-- Requires Postgres 13+ for built-in gen_random_uuid() (Neon runs 16).

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id);

CREATE TABLE IF NOT EXISTS websites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  handle TEXT UNIQUE,
  business_name TEXT,
  template TEXT NOT NULL DEFAULT 'clean',
  sections JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_domain TEXT,
  launched BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_websites_handle ON websites(handle);

-- Sliding-window rate limiter: each (key, time) row is one attempt.
-- "key" is shaped like "login:ip:1.2.3.4" or "signup:email:foo@bar.com".
CREATE TABLE IF NOT EXISTS rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key_time ON rate_limits(key, attempted_at DESC);

-- Email verification + password reset tokens. We store only a hash, never the
-- raw token, so a DB leak alone can't be used to compromise accounts.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                  -- 'verify_email' | 'reset_password'
  token_hash TEXT NOT NULL UNIQUE,     -- sha256 of the raw token
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);

-- Email verification flag on users. NULL = unverified.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Clients (CRM): leads / actives / paused, with LTV, tags, notes.
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  stage TEXT NOT NULL DEFAULT 'lead' CHECK (stage IN ('lead', 'active', 'paused')),
  tags TEXT[] NOT NULL DEFAULT '{}'::text[],
  notes TEXT,
  lifetime_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  source TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clients_workspace_stage ON clients(workspace_id, stage);

-- Calendar settings (1:1 with workspace). availability is stored as JSONB:
--   { "0": [], "1": [{"start": 540, "end": 1020}], ... }
-- where keys are weekday (0=Sun..6=Sat) and start/end are minutes from midnight.
CREATE TABLE IF NOT EXISTS calendar_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  biz_name TEXT NOT NULL DEFAULT 'My business',
  slug TEXT UNIQUE,
  slot_minutes INT NOT NULL DEFAULT 30,
  buffer_minutes INT NOT NULL DEFAULT 0,
  availability JSONB NOT NULL DEFAULT '{"0":[],"1":[{"start":540,"end":1020}],"2":[{"start":540,"end":1020}],"3":[{"start":540,"end":1020}],"4":[{"start":540,"end":1020}],"5":[{"start":540,"end":840}],"6":[]}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calendar_settings_slug ON calendar_settings(slug);

-- Services offered (linked from bookings).
CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  duration_minutes INT NOT NULL,
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  display_order INT NOT NULL DEFAULT 0,
  availability JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_services_workspace ON services(workspace_id, display_order);

-- Calendar blocks (manually unavailable times).
CREATE TABLE IF NOT EXISTS calendar_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  start_min INT NOT NULL,
  end_min INT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_blocks_workspace_date ON calendar_blocks(workspace_id, date);

-- Bookings (created via public booking link or owner directly).
CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  date DATE NOT NULL,
  start_min INT NOT NULL,
  end_min INT NOT NULL,
  notes TEXT,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bookings_workspace_date ON bookings(workspace_id, date);

-- ── Programs: sellable courses / coaching programs / paid communities ──
-- Content is soft-deleted (deleted_at) and enrollments live in their own
-- table, so editing or removing content never touches a member's access
-- or subscription. Deleting a program archives it (no new sales; existing
-- members keep access until their subscription ends or is revoked).
CREATE TABLE IF NOT EXISTS programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  cover_url TEXT,
  price_cents INT NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  billing TEXT NOT NULL DEFAULT 'one_time' CHECK (billing IN ('one_time', 'month', 'year')),
  community_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_programs_workspace ON programs(workspace_id, status);

CREATE TABLE IF NOT EXISTS program_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('pdf', 'post', 'video')),
  title TEXT NOT NULL,
  body TEXT,
  file_url TEXT,
  file_name TEXT,
  youtube_id TEXT,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_program_items_program ON program_items(program_id, position);

CREATE TABLE IF NOT EXISTS program_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'purchase', 'subscription')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'cancelled')),
  price_cents INT NOT NULL DEFAULT 0,
  billing TEXT NOT NULL DEFAULT 'one_time',
  stripe_subscription_id TEXT,
  stripe_session_id TEXT,
  current_period_end TIMESTAMPTZ,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_enrollments_sub ON program_enrollments(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_program_enrollments_session ON program_enrollments(stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_program_enrollments_client ON program_enrollments(client_id, status);
CREATE INDEX IF NOT EXISTS idx_program_enrollments_program ON program_enrollments(program_id, status);

CREATE TABLE IF NOT EXISTS program_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id UUID NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES program_posts(id) ON DELETE CASCADE,
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  author_client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  is_owner BOOLEAN NOT NULL DEFAULT FALSE,
  kind TEXT NOT NULL DEFAULT 'post' CHECK (kind IN ('post', 'win', 'question')),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_program_posts_program ON program_posts(program_id, created_at DESC);

-- Access window for one-time programs (NULL = forever). Subscriptions end
-- when Stripe says so; one-time access ends access_days after purchase.
ALTER TABLE programs ADD COLUMN IF NOT EXISTS access_days INT CHECK (access_days IS NULL OR access_days > 0);
ALTER TABLE program_enrollments ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_program_enrollments_expiry ON program_enrollments(expires_at) WHERE status = 'active' AND expires_at IS NOT NULL;

-- Unusual-activity watch (api/_lib/activityWatch.js). activity_reads is a
-- small counter per account (or per hashed network address) per hour:
-- how many different pages of data it read. activity_flags is one row per
-- subject per day once a count passes a line; Admin > Risk reads it.
-- activity_trust marks an account the operator has said is fine.
CREATE TABLE IF NOT EXISTS activity_reads (
  subject TEXT NOT NULL,
  bucket TIMESTAMPTZ NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, bucket)
);
CREATE INDEX IF NOT EXISTS idx_activity_reads_bucket ON activity_reads (bucket);
CREATE TABLE IF NOT EXISTS activity_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject TEXT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  flag_day DATE NOT NULL,
  peak_hour INTEGER NOT NULL DEFAULT 0,
  day_total INTEGER NOT NULL DEFAULT 0,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  slow_until TIMESTAMPTZ,
  slowed_at TIMESTAMPTZ,
  first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  UNIQUE (subject, kind, flag_day)
);
CREATE INDEX IF NOT EXISTS idx_activity_flags_recent ON activity_flags (first_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_flags_slow ON activity_flags (subject, slow_until) WHERE slow_until IS NOT NULL;
CREATE TABLE IF NOT EXISTS activity_trust (
  subject TEXT PRIMARY KEY,
  until TIMESTAMPTZ NOT NULL,
  by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Confirm-first sign-up (api/_lib/signupTicket.js). TRUE from the moment a
-- sign-up is taken until the link in the confirmation email is opened;
-- until then the account cannot be signed in to. Accounts from before this
-- (and from older iPhone app versions) are FALSE and unaffected.
ALTER TABLE users ADD COLUMN IF NOT EXISTS confirm_required BOOLEAN NOT NULL DEFAULT FALSE;

-- Time tracking was retired (api/_lib/retired.js). A timer left running has
-- no screen to stop it from any more, so it is stopped here, once, with the
-- time it had run so far. Entries themselves are kept.
UPDATE time_entries SET
       ended_at = COALESCE(ended_at, NOW()),
       duration_seconds = COALESCE(duration_seconds, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at))::int)),
       status = 'stopped', updated_at = NOW()
 WHERE status = 'running';
