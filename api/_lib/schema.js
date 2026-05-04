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
-- Tracks first-run onboarding completion so we know whether to route the
-- owner to /onboarding or straight to /dashboard. Self-correcting backfill:
-- any pre-existing workspace that already has clients or services is marked
-- onboarded so existing users don't get bumped through the wizard.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;
UPDATE workspaces w SET onboarded_at = created_at
WHERE onboarded_at IS NULL
  AND (
    EXISTS (SELECT 1 FROM clients  WHERE workspace_id = w.id)
    OR EXISTS (SELECT 1 FROM services WHERE workspace_id = w.id)
  );

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
-- Welcome-email sequence tracker. Keys are 'day1' | 'day3' | 'day7' | 'day14',
-- values are ISO timestamps. Stored as JSONB so we can add new beats later
-- without another migration.
ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_sent JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Backfill: any user already past the whole 14-day window when this column
-- lands gets marked as fully sent so the cron doesn't retroactively spam
-- pre-existing accounts. Self-correcting via the empty-jsonb check.
UPDATE users
SET welcome_sent = jsonb_build_object(
  'day1',  created_at::text,
  'day3',  created_at::text,
  'day7',  created_at::text,
  'day14', created_at::text
)
WHERE welcome_sent = '{}'::jsonb
  AND created_at < NOW() - INTERVAL '14 days';

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
ALTER TABLE clients ADD COLUMN IF NOT EXISTS referred_by_client_id UUID REFERENCES clients(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_clients_referred_by ON clients(referred_by_client_id);

-- Client portal: when an end-customer signs up to THRYVE, we link their user
-- account to every existing `clients` row that matches their email so they
-- can see their data across multiple businesses they book with. user_id
-- nullable because most rows are created by owners before the client signs up.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id);

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
-- Discover: opt-in directory listing on /me/discover. A business with
-- discoverable=true and a slug is shown to all signed-in clients. Tagline
-- is the one-line pitch shown under the business name on the listing.
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS discoverable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS tagline TEXT;
CREATE INDEX IF NOT EXISTS idx_calendar_settings_discoverable ON calendar_settings(discoverable) WHERE discoverable = TRUE;

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
-- Per-booking reminder-fire tracker. Keys are the reminder_minutes value as
-- a string (e.g. '120' for the 2-hour reminder); values are ISO timestamps.
-- The cron checks `reminders_sent ? key` so each beat fires exactly once.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminders_sent JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_bookings_workspace_date ON bookings(workspace_id, date);

-- Messaging: one thread per (workspace, client). Mode controls whether the
-- client can reply (two-way) or only receive announcements (one-way / broadcast).
CREATE TABLE IF NOT EXISTS message_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'two-way' CHECK (mode IN ('two-way', 'one-way')),
  unread_biz INT NOT NULL DEFAULT 0,
  unread_client INT NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_threads_workspace_recent ON message_threads(workspace_id, last_message_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('biz', 'client', 'system')),
  text TEXT,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  kind TEXT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

-- Documents: e-sign workflow. PDF upload + drag-drop field placement land in
-- later phases; the schema accommodates them now via kind/file_url/page_count.
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'written' CHECK (kind IN ('pdf', 'written')),
  content_html TEXT,
  file_url TEXT,
  page_count INT NOT NULL DEFAULT 1,
  fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  recipient_client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  recipient_name TEXT,
  recipient_email TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'completed', 'voided')),
  sign_token_hash TEXT UNIQUE,
  sent_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  activity JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id, status);

-- Per-workspace finance settings (next invoice number, default tax, currency).
CREATE TABLE IF NOT EXISTS finance_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  next_invoice_number INT NOT NULL DEFAULT 1001,
  default_tax_rate NUMERIC(6,3) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD'
);

-- Invoices. Line items live in JSONB to keep editing transactional and simple
-- (each item: { id, description, quantity, rate }).
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  client_name TEXT,
  client_email TEXT,
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  tax_rate NUMERIC(6,3) NOT NULL DEFAULT 0,
  discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'voided')),
  view_token_hash TEXT UNIQUE,
  sent_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  paid_method TEXT,
  activity JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, number)
);
CREATE INDEX IF NOT EXISTS idx_invoices_workspace_status ON invoices(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_workspace_issued ON invoices(workspace_id, issue_date DESC);

-- Goals + Tasks. Goals track progress against a target (revenue / clients /
-- sessions / custom). Tasks are simple to-dos; "smart" tasks of certain types
-- can auto-complete from app activity (e.g. send-invoice flips when an invoice
-- is sent to that client).
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'generic' CHECK (type IN ('generic', 'message-client', 'send-invoice', 'send-document')),
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  completed_auto BOOLEAN NOT NULL DEFAULT FALSE,
  due_date DATE,
  notes TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_open ON tasks(workspace_id, done, due_date);

CREATE TABLE IF NOT EXISTS goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'custom' CHECK (type IN ('revenue', 'clients', 'sessions', 'custom')),
  target NUMERIC(12,2) NOT NULL,
  current_manual NUMERIC(12,2) NOT NULL DEFAULT 0,
  deadline DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_goals_workspace ON goals(workspace_id, deadline);

-- Rewards: per-workspace launched flag, rules, and redemptions log.
CREATE TABLE IF NOT EXISTS reward_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  launched_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS reward_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('visit', 'spend', 'referral', 'custom')),
  name TEXT NOT NULL,
  trigger_text TEXT,
  reward_text TEXT,
  threshold NUMERIC(12,2) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reward_rules_workspace ON reward_rules(workspace_id, active);

CREATE TABLE IF NOT EXISTS reward_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_id UUID REFERENCES reward_rules(id) ON DELETE SET NULL,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  client_name TEXT,
  reward_text TEXT,
  notes TEXT,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_redemptions_workspace ON reward_redemptions(workspace_id, redeemed_at DESC);
-- Rewards lifecycle: 'issued' → owner has confirmed and notified the client,
-- but it hasn't been used yet; 'used' → client cashed it in; 'dismissed' →
-- owner ignored the auto-detected eligibility (still counts toward the
-- earned-vs-claimed math so the same milestone doesn't fire twice).
ALTER TABLE reward_redemptions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'used';
ALTER TABLE reward_redemptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE reward_redemptions ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
ALTER TABLE reward_redemptions ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
ALTER TABLE reward_redemptions ADD COLUMN IF NOT EXISTS auto_detected BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_redemptions_rule_client ON reward_redemptions(rule_id, client_id);

-- Ivy Pro: AI coach chat history. Each workspace owns its sessions; messages
-- live in a child table so we can stream and paginate later. Replies are
-- generated server-side (mock now, real Anthropic API later) so the secret
-- never reaches the browser.
CREATE TABLE IF NOT EXISTS ivy_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ivy_sessions_workspace ON ivy_sessions(workspace_id, last_message_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS ivy_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES ivy_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('me', 'ivy')),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ivy_messages_session ON ivy_messages(session_id, created_at);

-- Per-workspace Anthropic usage tracking. One row per (workspace, day, model)
-- so we can cap daily spend, surface usage in the UI, and later tier on plan.
CREATE TABLE IF NOT EXISTS ivy_usage (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  model TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  request_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, day, model)
);
CREATE INDEX IF NOT EXISTS idx_ivy_usage_workspace ON ivy_usage(workspace_id, day DESC);
`;
