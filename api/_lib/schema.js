// Postgres schema as a JS module string. Imported by api/admin/migrate.js so the
// schema travels inside the function bundle (Vercel doesn't include non-JS files
// by default). Keep schema.sql in sync as a human-readable mirror.
//
// Apply once after deploy via:
//   POST /api/admin/migrate  -H "x-admin-secret: $ADMIN_SECRET"
//
// Requires Postgres 13+ for built-in gen_random_uuid() (Neon runs 16).

export const SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key_time ON rate_limits(key, attempted_at DESC);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

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

CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  duration_minutes INT NOT NULL,
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  display_order INT NOT NULL DEFAULT 0,
  description TEXT,
  photo_url TEXT,
  prep_instructions TEXT,
  reminder_minutes INT[] NOT NULL DEFAULT ARRAY[10080, 2880, 1440, 120]::int[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE services ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS prep_instructions TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS reminder_minutes INT[] NOT NULL DEFAULT ARRAY[10080, 2880, 1440, 120]::int[];
CREATE INDEX IF NOT EXISTS idx_services_workspace ON services(workspace_id, display_order);

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
  recurrence_rule TEXT,
  recurrence_until DATE,
  cancelled_occurrences DATE[] NOT NULL DEFAULT '{}'::date[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS recurrence_rule TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS recurrence_until DATE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_occurrences DATE[] NOT NULL DEFAULT '{}'::date[];
CREATE INDEX IF NOT EXISTS idx_bookings_workspace_date ON bookings(workspace_id, date);
`;
