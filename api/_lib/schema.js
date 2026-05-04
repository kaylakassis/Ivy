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

-- Subscription state. Owners need an active sub (or live trial) to use the
-- business app — the client portal is always free. Status mirrors Stripe's:
--   trialing | active | past_due | cancelled | inactive
-- New workspaces start trialing for 14 days. Existing workspaces get the
-- same grace window so the rollout doesn't paywall anyone overnight.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_status    TEXT NOT NULL DEFAULT 'trialing';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS trial_ends_at          TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days');
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_period_end TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
-- One-time backfill for any workspace that existed before this column was
-- added (the DEFAULT only applies to inserts).
UPDATE workspaces SET trial_ends_at = NOW() + INTERVAL '14 days'
WHERE trial_ends_at IS NULL AND subscription_status = 'trialing';

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
-- Phone + per-client SMS consent. sms_consent_at NULL means "not opted in"
-- — the reminders cron and any future broadcast paths will skip them.
-- Phone stored normalized to E.164 (+15551234567); pre-normalize before
-- write (see _lib/sms.js).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS sms_consent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone) WHERE phone IS NOT NULL;

-- Client portal: when an end-customer signs up to THRYVE, we link their user
-- account to every existing 'clients' row that matches their email so they
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
-- iCal subscription feed. Owner generates a token and pastes the resulting
-- URL into Google Cal / Apple Cal / Outlook to mirror their THRYVE bookings
-- into their personal calendar. We store the sha256 of the token so leaked
-- DB rows can't be replayed; the raw token only lives in the URL the owner
-- shares with their own calendar app.
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS ical_feed_token_hash TEXT;
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS ical_feed_token_created_at TIMESTAMPTZ;
-- Google Calendar OAuth: refresh_token encrypted at rest (uses _lib/secrets).
-- google_calendar_id is the dedicated "THRYVE Bookings" calendar we create
-- on connect; google_email is for display on the Sync drawer ("connected
-- as kayla@gmail.com"). Disconnecting clears all four.
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS google_refresh_token_encrypted TEXT;
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS google_calendar_id TEXT;
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS google_email TEXT;
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS google_connected_at TIMESTAMPTZ;
-- Inbound busy-block sync: when enabled, the cron pulls busy times from
-- the owner's connected Google calendar and stores them as opaque
-- external_busy_blocks. The slot-conflict check on the public booking
-- page consults those blocks so a personal event blocks the THRYVE slot
-- automatically.
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS google_block_inbound BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS google_inbound_last_sync_at TIMESTAMPTZ;
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS google_inbound_last_error TEXT;
-- Discover filters. Owners set these in the website builder so client
-- searches on the /me/discover tab can compose them with service queries.
-- address_label is the human-readable line shown on the card; lat/lng
-- power radius search via haversine. Optional — businesses without
-- coordinates are excluded from distance-bounded queries but still match
-- non-distance filters.
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS address_label TEXT;
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
CREATE INDEX IF NOT EXISTS idx_calendar_settings_latlng
  ON calendar_settings(lat, lng) WHERE lat IS NOT NULL AND lng IS NOT NULL;
-- Service-name search: pg_trgm makes ILIKE '%foo%' index-backed at scale.
-- Falls back gracefully (sequential scan) on Postgres builds without it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_services_name_trgm
  ON services USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_services_workspace_price
  ON services(workspace_id, price);

-- Reviews. Tied to a specific booking so we can prove the reviewer was
-- actually a client + a UNIQUE (booking_id) prevents review spam. Hidden
-- reviews don't count in the average; owners can reply with one
-- owner_response per review.
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  reviewer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewer_name TEXT NOT NULL,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text TEXT,
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  owner_response TEXT,
  owner_responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reviews_workspace_recent
  ON reviews(workspace_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_unique_per_booking
  ON reviews(booking_id) WHERE booking_id IS NOT NULL;

-- Mirror of busy times from the owner's connected external calendar
-- (Google for now). Treated as opaque blockers in slot availability
-- — never editable from THRYVE. Refreshed by api/cron/google-busy-sync;
-- rows the most-recent sync didn't include are deleted, so cancellations
-- in the upstream calendar free the slot back up automatically.
CREATE TABLE IF NOT EXISTS external_busy_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'google',
  source_event_id TEXT,
  date DATE NOT NULL,
  start_min INT NOT NULL,
  end_min INT NOT NULL,
  summary TEXT,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_external_busy_workspace_date
  ON external_busy_blocks(workspace_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_busy_workspace_event
  ON external_busy_blocks(workspace_id, source, source_event_id)
  WHERE source_event_id IS NOT NULL;
-- Coarse category for the Discover directory (Wellness / Beauty / Fitness /
-- Health / Professional). Optional — null means "uncategorized" and the biz
-- only matches the All chip.
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS category TEXT;
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
-- The cron checks reminders_sent ? key so each beat fires exactly once.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminders_sent JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Google Calendar event id, set when we successfully push a booking into
-- the workspace's connected Google Cal. Lets us PUT/DELETE later.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS google_event_id TEXT;
-- SMS reminder tracking — parallel to reminders_sent (which is email).
-- Same key shape: { '120': '<iso>', '1440': '<iso>', ... }. Decoupled
-- so a Twilio failure doesn't re-fire the email on the next cron tick.
-- client_phone snapshots clients.phone at booking time, so reminders
-- still go out even if the client later updates / deletes the row.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_phone TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sms_sent JSONB NOT NULL DEFAULT '{}'::jsonb;
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
-- Stripe credentials, encrypted at rest. Owners paste their own restricted
-- API key + webhook signing secret; we never see the plaintext after write.
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS stripe_publishable_key TEXT;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS stripe_secret_encrypted TEXT;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS stripe_webhook_secret_encrypted TEXT;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS stripe_account_label TEXT;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS stripe_connected_at TIMESTAMPTZ;

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
-- Tracks the most recent Stripe checkout session per invoice. Webhook lookup
-- uses this to find the invoice when checkout.session.completed fires.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_invoices_stripe_session ON invoices(stripe_session_id) WHERE stripe_session_id IS NOT NULL;

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
