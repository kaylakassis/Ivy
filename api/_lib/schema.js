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
-- New workspaces start trialing for 28 days. Existing workspaces get a
-- grace window so the rollout doesn't paywall anyone overnight.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_status    TEXT NOT NULL DEFAULT 'trialing';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS trial_ends_at          TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '28 days');
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_period_end TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_customer_id     TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

-- Dunning state. subscription_past_due_since is stamped on the first
-- invoice.payment_failed webhook; cleared on payment_succeeded. The
-- subscription-dunning cron uses it to find workspaces past the
-- grace period and flip them to 'suspended'. Suspension blocks
-- write actions in the UI (gating layered in clientPortal.js +
-- handler-level guards) but keeps the account/billing surface
-- reachable so the owner can update their card.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_past_due_since TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_suspended_at  TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_last_dunning_at TIMESTAMPTZ;
-- Update the column default for any future workspace inserts that bypass
-- the explicit value (e.g. raw SQL admin tooling).
ALTER TABLE workspaces ALTER COLUMN trial_ends_at SET DEFAULT (NOW() + INTERVAL '28 days');
-- One-time backfill for any workspace that existed before this column was
-- added (the DEFAULT only applies to inserts).
UPDATE workspaces SET trial_ends_at = NOW() + INTERVAL '28 days'
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

-- Multi-page sites + customization.
--
-- pages: ordered JSONB array of page objects. Each entry has:
--   id, slug, title, sections (array), in_nav (bool)
-- The legacy sections column above holds the HOME pages sections when
-- pages is empty (backward compat for sites that have not migrated).
-- New sites populate pages from day one with the home page having
-- slug = empty string (i.e. the root URL).
ALTER TABLE websites ADD COLUMN IF NOT EXISTS pages JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Draft vs published separation. The editor auto-saves drafts into
-- sections/pages; these hold the snapshot served to the public, written
-- ONLY on Publish. Nullable so already-published sites fall back to the
-- live columns (COALESCE in publicSite.js) until their next Publish.
ALTER TABLE websites ADD COLUMN IF NOT EXISTS published_sections JSONB;
ALTER TABLE websites ADD COLUMN IF NOT EXISTS published_pages JSONB;
-- Owner-supplied CSS injected into the rendered site. The public
-- renderer wraps it in a style tag inside the var()-themed site shell
-- so it scopes naturally to within the site wrapper.
ALTER TABLE websites ADD COLUMN IF NOT EXISTS custom_css TEXT;
-- Optional font-pair override that takes precedence over the template's
-- font choices. Stored as a preset id; renderer maps to actual fonts.
ALTER TABLE websites ADD COLUMN IF NOT EXISTS font_pair TEXT;
-- Site-level SEO. Per-page meta lives inside the pages JSONB blob
-- (metaTitle / metaDescription / ogImage on each page object). These
-- columns are the defaults the SSR endpoint uses when the page-level
-- override is empty.
ALTER TABLE websites ADD COLUMN IF NOT EXISTS seo_title TEXT;
ALTER TABLE websites ADD COLUMN IF NOT EXISTS seo_description TEXT;
ALTER TABLE websites ADD COLUMN IF NOT EXISTS seo_og_image TEXT;
ALTER TABLE websites ADD COLUMN IF NOT EXISTS favicon_url TEXT;

-- Custom-domain attach status. NULL when no custom domain is set;
-- otherwise one of unverified / dns_pending / verified / failed.
ALTER TABLE websites ADD COLUMN IF NOT EXISTS domain_status TEXT;
-- 301 redirects — array of { from, to }. Renderer checks this map
-- before doing the page-level resolution.
ALTER TABLE websites ADD COLUMN IF NOT EXISTS redirects JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Form destinations — array of { formId, type: 'email'|'webhook',
-- config: {...} }. The public form-submission endpoint routes inbound
-- submissions through these.
ALTER TABLE websites ADD COLUMN IF NOT EXISTS form_destinations JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Exit-intent popup + sticky CTA — single config objects each, applied
-- site-wide. Empty = disabled.
ALTER TABLE websites ADD COLUMN IF NOT EXISTS exit_intent_popup JSONB;
ALTER TABLE websites ADD COLUMN IF NOT EXISTS sticky_cta JSONB;
-- Scheduled publish — when scheduled_publish_at <= NOW(), the cron
-- copies scheduled_pages → pages + clears these fields.
ALTER TABLE websites ADD COLUMN IF NOT EXISTS scheduled_publish_at TIMESTAMPTZ;
ALTER TABLE websites ADD COLUMN IF NOT EXISTS scheduled_pages JSONB;

-- Version history: a snapshot row inserted on every Publish so owners
-- can roll back a bad release.
CREATE TABLE IF NOT EXISTS website_versions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id  UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  snapshot    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_website_versions_site_time ON website_versions(website_id, created_at DESC);

-- Pageview analytics — one row per visit. UA classified into broad
-- buckets (mobile / desktop / bot) instead of stored verbatim to avoid
-- accidental PII. Referrer is truncated.
CREATE TABLE IF NOT EXISTS website_pageviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id  UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  page_slug   TEXT NOT NULL DEFAULT '',
  referrer    TEXT,
  ua_class    TEXT NOT NULL DEFAULT 'unknown',
  viewed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_website_pageviews_site_time ON website_pageviews(website_id, viewed_at DESC);

-- Form submissions — stored alongside the routed delivery so owners can
-- see what came in even when the destination fails.
CREATE TABLE IF NOT EXISTS website_form_submissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id  UUID NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  form_id     TEXT NOT NULL,
  payload     JSONB NOT NULL,
  delivered   BOOLEAN NOT NULL DEFAULT FALSE,
  delivery_err TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_website_form_submissions_site_time ON website_form_submissions(website_id, submitted_at DESC);

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
-- One-time UI walkthrough flag. NULL = the user hasn't seen / dismissed
-- the in-app tour yet, so AppShell auto-launches it. Re-launchable from
-- the Account page via a Replay button that POSTs { reset: true } and
-- nulls this back out.
ALTER TABLE users ADD COLUMN IF NOT EXISTS walkthrough_completed_at TIMESTAMPTZ;
-- Per-tab tutorial completion. Map of { [tabId]: 'completed' | 'skipped' }
-- so the Topbar info-button can auto-open the walkthrough on a tab's
-- first visit and stay quiet on subsequent visits. Owners can re-open
-- any tab's tutorial via the persistent (i) button regardless of the
-- map state — this only drives auto-trigger.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tutorials_completed JSONB NOT NULL DEFAULT '{}'::jsonb;

-- User classification — independent of subscription state.
--   'regular'    default. Honors normal billing rules.
--   'sponsored'  comp account: full app access without a subscription.
--                Bypasses Paywall via the userContext virtual sub flag.
--   'affiliate'  the human owns an affiliate code in 'affiliates'. Can
--                also be 'regular' + sponsored if needed; user_type just
--                records the primary classification for admin filtering.
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_type TEXT NOT NULL DEFAULT 'regular';
-- Per-user, per-type notification opt-outs. Keys are notification type
-- ids (messages | bookings | documents | payments | support); values
-- are booleans. Missing key → enabled. Set false → muted. Not using a
-- separate column per type so we can add new types later without a
-- schema change.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Idempotent constraint via DROP IF EXISTS + ADD. Two plain statements
-- play nicer with our naive migration runner than a DO block would.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_user_type_check;
ALTER TABLE users ADD CONSTRAINT users_user_type_check
  CHECK (user_type IN ('regular', 'sponsored', 'affiliate', 'super_admin'));
CREATE INDEX IF NOT EXISTS idx_users_user_type ON users(user_type)
  WHERE user_type <> 'regular';

-- Affiliate program. One row per affiliate user; 'code' is what they
-- share, ?ref=CODE on /signup attributes the conversion. Owner-side the
-- admin can rotate the code without breaking past attributions because
-- they're stored on affiliate_uses by id, not code.
CREATE TABLE IF NOT EXISTS affiliates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliates_user ON affiliates(user_id);

-- Each click-through-and-signup. We stamp the affiliate at signup time
-- (?ref=CODE) so attribution survives later code rotation. 'became_paid_at'
-- + 'monthly_value_cents' populate when the referred user starts paying so
-- the admin can compute revenue-per-affiliate.
CREATE TABLE IF NOT EXISTS affiliate_uses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id UUID NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  referred_user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  signed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  became_paid_at TIMESTAMPTZ,
  monthly_value_cents INT
);
CREATE INDEX IF NOT EXISTS idx_affiliate_uses_affiliate
  ON affiliate_uses(affiliate_id, signed_up_at DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_uses_paid
  ON affiliate_uses(affiliate_id, became_paid_at)
  WHERE became_paid_at IS NOT NULL;

-- ─── Self-serve referral program ("refer one, get one") ──────────────
-- Distinct from the admin-managed affiliates program above. EVERY
-- business owner gets a referral code they set themselves in Settings.
-- When a new user signs up with that code AND becomes a paying owner,
-- the referrer gets one month credited to their Stripe customer
-- balance (next billing cycle effectively waived). Stacks: N
-- conversions = N free months.
--
-- referral_codes: one self-set code per owner (user). Code is stored
-- uppercased; uniqueness is global so a link ?ref=CODE resolves to
-- exactly one owner.
CREATE TABLE IF NOT EXISTS referral_codes (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(UPPER(code));

-- referrals: one row per referred signup. converted_at stamps when the
-- referred user first becomes a paying owner; rewarded_at stamps when
-- the referrer actually received their free month (only granted while
-- the referrer is an active paying owner — see api/_lib/referrals.js).
CREATE TABLE IF NOT EXISTS referrals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id  UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  code              TEXT NOT NULL,
  signed_up_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  converted_at      TIMESTAMPTZ,
  rewarded_at       TIMESTAMPTZ,
  reward_cents      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id, signed_up_at DESC);
-- The sweep that grants pending rewards filters by (referrer, converted
-- but not yet rewarded).
CREATE INDEX IF NOT EXISTS idx_referrals_pending
  ON referrals(referrer_user_id)
  WHERE converted_at IS NOT NULL AND rewarded_at IS NULL;

-- admin replies inline. Polling-based — realtime can come later. Mirrors
-- the message_threads / messages pattern but a separate table so support
-- traffic doesn't pollute the per-business chat table.
CREATE TABLE IF NOT EXISTS support_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  unread_admin INT NOT NULL DEFAULT 0,
  unread_user  INT NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  last_message_preview TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('user', 'admin')),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_messages_thread
  ON support_messages(thread_id, created_at);

-- Admin audit trail. Every super-admin-initiated mutation appends a row.
-- 'actor_user_id' is the admin who took the action; 'target_user_id' is
-- whoever was affected (nullable for tenant-wide ops). 'meta' stores
-- whatever extra context the call site provides (old/new values, IP, etc.)
-- so we don't have to add columns every time we want to log a new field.
CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_created
  ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_target
  ON audit_events(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor
  ON audit_events(actor_user_id, created_at DESC);

-- Newsletter signups from the public marketing site. Anonymous
-- (no auth) so we treat the email as the unique key. source tracks
-- where the form was — 'home', 'changelog', etc. — so we can see
-- which pages convert.
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  source TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unsubscribed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_newsletter_created
  ON newsletter_subscribers(created_at DESC);

-- Owner email campaigns / newsletters. body is owner-authored text; we
-- escape + wrap it in the branded email shell at send time. audience is
-- 'all-clients' | 'tag:<tag>' | 'newsletter' (the owner's website
-- newsletter sign-ups). Marketing-type sends honor each recipient's
-- opt-out + carry a List-Unsubscribe header.
CREATE TABLE IF NOT EXISTS email_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT 'all-clients',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent')),
  recipient_count INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_workspace
  ON email_campaigns(workspace_id, created_at DESC);

-- Retail products / inventory for the in-person quick-sale (POS) and as
-- invoice line items. track_stock=false = unlimited (e.g. a service-like
-- SKU); when true, stock_qty is decremented atomically on each sale.
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT,
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  cost NUMERIC(12,2),
  track_stock BOOLEAN NOT NULL DEFAULT TRUE,
  stock_qty INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_workspace ON products(workspace_id, active);

-- Legal acceptances. Append-only audit trail of every time a user
-- accepted a versioned legal document (terms, privacy, AI disclaimer).
-- IP + user_agent stored for legal evidentiary purposes; never deleted.
-- Plus denormalized columns on users so we can answer "have they
-- accepted the current terms" with one cheap column read instead of
-- a join + sort.
CREATE TABLE IF NOT EXISTS legal_acceptances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document TEXT NOT NULL,
  version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_user
  ON legal_acceptances(user_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_doc_version
  ON legal_acceptances(document, version);

ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT;
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
-- Client-add invite. When an owner adds a client with an email (or
-- imports them), we email a "claim your account" link once. Stamp
-- prevents resending on rapid edits / re-imports.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS invite_sent_at TIMESTAMPTZ;

-- Web Push subscriptions. One row per (user, browser/device). Each
-- subscription is an endpoint URL + the public ECDH + auth keys the
-- browser issued. We strip rows on 404/410 from the push provider so
-- stale subscriptions clear themselves.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_user_endpoint
  ON push_subscriptions(user_id, endpoint);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(user_id);

-- Client portal: when an end-customer signs up to THRYVE, we link their user
-- account to every existing 'clients' row that matches their email so they
-- can see their data across multiple businesses they book with. user_id
-- nullable because most rows are created by owners before the client signs up.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(user_id);
-- Saved address for mobile-service bookings. Captured at first booking;
-- the public booker pre-fills it on subsequent visits.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address TEXT;
-- Saved card on file (Stripe customer + default payment method per
-- workspace). Workspace-scoped because Stripe Connect accounts are
-- per-workspace — a client can have a card saved with biz A but not
-- with biz B. We never store full PANs; only the Stripe handles +
-- display fragments (brand, last 4 digits, exp month/year) so the
-- portal UI can render "Visa ending in 4242" without an extra round
-- trip.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_method_id TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_method_brand TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_method_last4 TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_method_exp_month INT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payment_method_exp_year INT;
CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer
  ON clients(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Profile fields. Owners can attach a profile photo + a list of files
-- per client (e.g. trainer before/after photos, intake-form scans,
-- consent forms). Files live in Vercel Blob; we store the public URL +
-- mime + filename + uploaded-at in a JSONB array. Capped at 100
-- attachments per client by application logic — no DB constraint.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Per-client photo gallery — distinct from "attachments" (which carries
-- arbitrary files like signed PDFs and intake-form scans). Each entry
-- shape: { id, url, blobPathname, caption?, takenAt?, uploadedAt }.
-- Personal trainers stash before/after photos here, stylists keep
-- transformation albums, contractors document job-site progress —
-- the surface is the same across verticals.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS gallery_photos JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Per-(client, workspace) email notification preferences. Same JSONB shape
-- as users.notification_prefs but keyed by the email-type ids in
-- EMAIL_NOTIFY_TYPES (api/_lib/notificationPrefs.js). Missing key = enabled.
-- Clients of multiple businesses naturally get one set of prefs per
-- membership (the clients table is workspace-scoped). NULL/false explicitly
-- disables that type for that client; transactional-critical sends
-- (verification, password reset, account deletion) ignore this.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;

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
-- Mobile service area: how far the owner travels from their base
-- location. Used in the public booking page to gate "where do you
-- need us?" inputs and (eventually) drive Discover-by-distance for
-- mobile providers. Nullable — owners who don't run mobile services
-- leave it untouched.
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS service_radius_miles INT
  CHECK (service_radius_miles IS NULL OR (service_radius_miles > 0 AND service_radius_miles <= 500));
-- IANA timezone name (e.g. "America/Los_Angeles"). Owner sets it during
-- onboarding so booking confirmations + Discover cards display the right
-- local time. Nullable for legacy rows; consumers fall back to UTC.
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS timezone TEXT;
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
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('visible', 'hidden', 'pending')),
  owner_response TEXT,
  owner_responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Reviews are held for owner moderation ('pending') before they go public.
-- Only 'visible' shows on the booking page / Discover / business profile;
-- the owner publishes or hides each from the Reviews tab. (Existing rows
-- were all 'visible' and stay so — only the allowed set + default change.)
ALTER TABLE reviews ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_status_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_status_check
  CHECK (status IN ('visible', 'hidden', 'pending')) NOT VALID;
CREATE INDEX IF NOT EXISTS idx_reviews_workspace_recent
  ON reviews(workspace_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_unique_per_booking
  ON reviews(booking_id) WHERE booking_id IS NOT NULL;
-- One review per signed-in client per business — prevents a verified
-- client from spamming. Only fires when reviewer_user_id is set, so
-- token-issued reviews (no logged-in user) still pass through cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_unique_per_user
  ON reviews(workspace_id, reviewer_user_id) WHERE reviewer_user_id IS NOT NULL;

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

-- Packages: owner-defined session bundles (e.g. "10 Cuts for $750"). Two
-- tables — packages is the template, client_packages is the per-client
-- purchase / assignment with a remaining-credits counter that decrements
-- when bookings consume a credit.
--
-- service_ids[] makes packages multi-service (e.g. "10 of any haircut"
-- across two services). Empty array means "valid for any service in
-- the workspace".
CREATE TABLE IF NOT EXISTS packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  service_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  session_count INT NOT NULL CHECK (session_count > 0),
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  expiry_days INT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_packages_workspace_active
  ON packages(workspace_id, active);

-- Snapshot pattern: name / service_ids / credits_total / price are
-- copied at sale time so owners can edit / delete the template later
-- without breaking outstanding bundles.
CREATE TABLE IF NOT EXISTS client_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  package_id UUID REFERENCES packages(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  service_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  credits_total INT NOT NULL,
  credits_remaining INT NOT NULL,
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','exhausted','expired','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (credits_remaining >= 0 AND credits_remaining <= credits_total)
);
CREATE INDEX IF NOT EXISTS idx_client_packages_client
  ON client_packages(client_id, status);
CREATE INDEX IF NOT EXISTS idx_client_packages_workspace
  ON client_packages(workspace_id, status);

-- Bookings link to the client_package they consume (if any) so cancels
-- can refund the credit and the owner / client can see "credit used"
-- on each session.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_package_id UUID
  REFERENCES client_packages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_client_package
  ON bookings(client_package_id) WHERE client_package_id IS NOT NULL;

-- Waitlist. When a slot is full (solo slot already booked, or group
-- class at capacity), clients can join a per-(service, date, start_min,
-- end_min) queue. On cancellation, the booking-cancel paths promote
-- the oldest waiting entry into a real booking + notify the client.
CREATE TABLE IF NOT EXISTS waitlist_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  client_phone TEXT,
  date DATE NOT NULL,
  start_min INT NOT NULL,
  end_min INT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','promoted','cancelled')),
  promoted_booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  promoted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_waitlist_slot
  ON waitlist_entries(workspace_id, service_id, date, start_min, end_min, status);
CREATE INDEX IF NOT EXISTS idx_waitlist_workspace_status
  ON waitlist_entries(workspace_id, status, created_at);
-- Email branding. Owners can upload a logo, pick an accent color
-- for buttons, and set a multi-line signature/footer that goes at
-- the bottom of every client-facing email (invoices, documents,
-- booking reminders, etc.). All optional — fall back to "thryve"
-- defaults when unset so existing workspaces don't change behavior
-- until the owner customizes.
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS brand_logo_url TEXT;
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS brand_logo_blob_pathname TEXT;
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS brand_accent_color TEXT;
ALTER TABLE calendar_settings ADD COLUMN IF NOT EXISTS brand_email_signature TEXT;

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
-- Group bookings: capacity > 1 means N clients can share the same slot
-- (yoga class, group therapy, fitness session). hasConflict permits
-- same-service+same-slot bookings up to this number; different-service
-- overlaps still conflict.
ALTER TABLE services ADD COLUMN IF NOT EXISTS capacity INT NOT NULL DEFAULT 1
  CHECK (capacity >= 1 AND capacity <= 1000);
ALTER TABLE services ADD COLUMN IF NOT EXISTS reminder_minutes INT[] NOT NULL DEFAULT ARRAY[10080, 2880, 1440, 120]::int[];
CREATE INDEX IF NOT EXISTS idx_services_workspace ON services(workspace_id, display_order);
-- Deposit policy. type='percent' → amount is 0–100 % of price.
-- type='fixed' → amount is USD. type='none' → pay-on-completion (default).
ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_type TEXT NOT NULL DEFAULT 'none'
  CHECK (deposit_type IN ('none', 'percent', 'fixed', 'full'));
ALTER TABLE services ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
-- 'full' was added later. The CHECK in the ADD COLUMN above is only
-- applied on first creation — for existing databases the inline check
-- still has the old (none/percent/fixed) values. We drop ANY existing
-- check constraint that references deposit_type by introspecting
-- pg_constraint, then add a fresh one. This is name-agnostic so it
-- survives whatever Postgres auto-named the original constraint.
DO $deposit_type_check$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'services' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%deposit_type%' AND pg_get_constraintdef(c.oid) NOT LIKE '%full%') THEN EXECUTE (SELECT 'ALTER TABLE services DROP CONSTRAINT ' || quote_ident(conname) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'services' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%deposit_type%' LIMIT 1); ALTER TABLE services ADD CONSTRAINT services_deposit_type_check_v2 CHECK (deposit_type IN ('none', 'percent', 'fixed', 'full')); END IF; END $deposit_type_check$;

-- Mobile / on-location services. location_type tells the booking flow
-- whether the service happens at the owner's place ('in_person'), at the
-- client's address ('mobile'), or over video ('virtual'). For mobile,
-- bookings carry a location_address; the service can also reserve
-- travel time around itself so the next booking on the same day isn't
-- stacked back-to-back across town.
ALTER TABLE services ADD COLUMN IF NOT EXISTS location_type TEXT NOT NULL DEFAULT 'in_person'
  CHECK (location_type IN ('in_person', 'mobile', 'virtual'));
ALTER TABLE services ADD COLUMN IF NOT EXISTS travel_buffer_minutes INT NOT NULL DEFAULT 0
  CHECK (travel_buffer_minutes >= 0 AND travel_buffer_minutes <= 240);
-- Per-service venue. For in_person services, a free-form address /
-- room / suite string shown on booking confirmations and the public
-- page so clients know exactly where to come. For virtual services, a
-- default meeting URL the owner uses (overrides the auto-Jitsi room
-- when set). Empty for mobile (the address comes from the client at
-- booking time and lives on the booking row itself).
ALTER TABLE services ADD COLUMN IF NOT EXISTS location_label TEXT;

-- Visibility model. 'public' = listed on Discover + the public booking
-- page; 'private' = bookable by direct link/ID but not in any list;
-- 'only_me' = completely hidden from clients (effectively a draft).
-- Same three states power services, packages, and websites so the
-- owner UI can render one selector everywhere.
ALTER TABLE services ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public', 'private', 'only_me'));
ALTER TABLE packages ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public', 'private', 'only_me'));
ALTER TABLE websites ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public', 'private', 'only_me'));

-- Cancellation + no-show fee policy. When fee_amount > 0 AND a card is
-- on file for the client, late-cancel/no-show actions auto-charge the
-- fee against the saved card. cancellation_window_hours is the
-- "free-cancel" buffer — anything inside that window is "late."
ALTER TABLE services ADD COLUMN IF NOT EXISTS cancellation_fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN IF NOT EXISTS cancellation_window_hours INT NOT NULL DEFAULT 24
  CHECK (cancellation_window_hours >= 0 AND cancellation_window_hours <= 720);
ALTER TABLE services ADD COLUMN IF NOT EXISTS no_show_fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Auto review requests: the daily cron mints a one-time token a few
-- days after a completed booking, hashes it onto the row, and emails
-- the client a "rate your experience" link. Once they submit (or the
-- cron caps out at the retry limit), the hash gets nulled so the
-- token can't be reused.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS review_request_token_hash TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_bookings_review_request_token
  ON bookings(review_request_token_hash) WHERE review_request_token_hash IS NOT NULL;

-- Per-booking deposit tracking. deposit_required is the snapshot of
-- what's owed at booking time (price * percent or fixed); deposit_paid
-- is what's actually been collected. payment_intent enables Stripe
-- refunds when a booking is cancelled.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_required NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_paid NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_paid_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_payment_intent TEXT;

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

-- Owners can use the calendar for personal events too — not just
-- "I'm unavailable" blocks but also things like "Vet appointment 3pm"
-- that they want to see on their own calendar without forcing clients
-- around them. blocks_bookings = TRUE keeps the legacy hard-block
-- behavior; FALSE means "show me this event but don't actually
-- conflict with bookings."
--
-- color: hex code the owner picked from the calendar drawer. Default
-- empty → use the muted "block" gray we ship today. Per-event color
-- coding is the cheapest UX upgrade for owners who manage 20+
-- events a week.
--
-- notes: owner-only private context (never exposed publicly). The
-- existing label column is also owner-only; on the public slot picker
-- everything is redacted to "Busy" regardless of what's stored.
ALTER TABLE calendar_blocks ADD COLUMN IF NOT EXISTS blocks_bookings BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE calendar_blocks ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE calendar_blocks ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE calendar_blocks ADD COLUMN IF NOT EXISTS all_day BOOLEAN NOT NULL DEFAULT FALSE;

-- Per-service color so the owner can visually distinguish a yoga
-- class from a massage at a glance. Default null → falls back to
-- the workspace's accent in the renderer.
ALTER TABLE services ADD COLUMN IF NOT EXISTS color TEXT;


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
-- Mobile / on-location address for this booking. NULL for in-person
-- (at the owner's location) and virtual bookings. Captured at the
-- booking step for mobile services (services.location_type = 'mobile').
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS location_address TEXT;
-- Cancellation / no-show fee tracking. fee_charged_amount is what we
-- actually charged (may differ from the service's policy if the owner
-- waived it manually); fee_payment_intent links to the Stripe charge
-- so refunds are possible. fee_charged_kind: 'late_cancel' | 'no_show'.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fee_charged_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fee_charged_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fee_charged_kind TEXT
  CHECK (fee_charged_kind IS NULL OR fee_charged_kind IN ('late_cancel', 'no_show'));
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fee_payment_intent TEXT;
-- No-show flag: marked by the owner when the client doesn't show up.
-- Distinct from cancellation — the slot is consumed but no service
-- happened. Surfaced in reports + can trigger a no-show fee charge.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS no_show_at TIMESTAMPTZ;
-- Tip captured after the session (post-service email link or owner UI).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tip_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tip_charged_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS tip_payment_intent TEXT;
-- Mutation timestamp. Initial CREATE TABLE bookings predates this so it
-- only ships via ALTER. Backfill with NOW() so existing rows aren't NULL.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Virtual / online services. Auto-generated meeting URL minted on
-- insert when the underlying service.location_type = 'virtual'.
-- One unique room per booking so links can't be reused after the
-- session ends. Currently we mint a Jitsi Meet room
-- (https://meet.jit.si/thryve-<token>) — zero-config, no API key
-- needed, works in every modern browser. Owners can override per
-- booking by setting their own URL (e.g. their Zoom personal room).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS video_room_url TEXT;

-- Service add-ons + per-service custom intake fields.
--
-- custom_fields shape: [{ id, label, type, required, options[] }]
--   • text / textarea / number / select / checkbox
--   • options[] only used when type='select'
-- Surfaced at the booking-details step on the public page so we capture
-- service-specific context up front (auto: vehicle make/model, pet
-- breed/size, tutor: subject/grade, etc.) instead of stuffing
-- everything into freeform notes.
--
-- add_ons shape: [{ id, name, price, durationMinutes }]
-- Optional extras the client picks at booking ("hot stones +$20",
-- "deep conditioning +$15"). Extends the slot duration by the sum
-- of selected add-ons' durationMinutes — slot grid recomputes from
-- (service.duration + selected add-ons).
ALTER TABLE services ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE services ADD COLUMN IF NOT EXISTS add_ons JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS custom_field_values JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS add_on_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Snapshot of total at booking time — service.price + sum(add-on prices)
-- minus any gift-card credit applied. Lets reports + invoices reflect
-- what was actually agreed without re-deriving from possibly-edited
-- service prices later.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_total NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Per-occurrence service completion log. Owner marks a booking complete
-- after the session and stashes a freeform note + photos/files. The
-- entry is visible to the specific client in their portal by default
-- (per-record toggle via visibleToClient inside each entry).
--
-- Keyed by ISO date (YYYY-MM-DD) of the occurrence. For non-recurring
-- bookings there's one entry under the booking's date column. For
-- recurring series, each occurrence the owner marks complete adds its
-- own entry. Mirrors the existing cancelled_occurrences DATE[] pattern
-- that already handles per-occurrence cancellations on the same row.
--
-- Shape per entry:
--   {
--     completedAt:        ISO timestamp,
--     completedByUserId:  UUID,           // who clicked (users.id)
--     completedByStaffId: UUID | null,    // for display attribution
--     notes:              string ≤ 8000,
--     attachments:        [{ url, blobPathname, mimeType, filename, uploadedAt }],
--     visibleToClient:    boolean
--   }
--
-- NOTE: completion_notes may contain PHI for healthcare verticals;
-- treat as sensitive in any future export / log redaction pass.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completion_log JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_bookings_workspace_date ON bookings(workspace_id, date);
-- Service-history view ("show me every completion for this client")
-- runs against this partial GIN index; non-completed bookings are
-- excluded so the index stays tight.
CREATE INDEX IF NOT EXISTS idx_bookings_completion_log
  ON bookings USING gin (completion_log)
  WHERE completion_log <> '{}'::jsonb;

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
-- Multi-signer: one row per signer per document. The legacy single-signer
-- shape on documents.recipient_* + sign_token_hash stays in place for
-- backward compatibility — new sends populate document_signers and use
-- per-signer tokens. Sequential ordering is encoded by order_index;
-- only the next-in-line signer has a usable sign_token_hash at any time.
CREATE TABLE IF NOT EXISTS document_signers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  order_index INT NOT NULL DEFAULT 0,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  sign_token_hash TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'awaiting', 'viewed', 'completed', 'declined')),
  field_values JSONB NOT NULL DEFAULT '[]'::jsonb,
  signed_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  decline_reason TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_document_signers_doc
  ON document_signers(document_id, order_index);
CREATE INDEX IF NOT EXISTS idx_document_signers_client
  ON document_signers(client_id) WHERE client_id IS NOT NULL;

-- Tamper-evidence: SHA-256 of (document body + ordered signer field
-- values + signed_at timestamps) computed at completion time. Makes a
-- subsequent edit to the document or its values detectable post-fact.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS completion_hash TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS decline_reason TEXT;
-- PDF support. file_url stores the Vercel Blob URL for the source PDF
-- the owner uploaded; pdf_blob_pathname is the matching pathname so we
-- can clean it up on delete. final_pdf_url is the flattened, stamped
-- PDF generated when all signers complete (signature image + text +
-- date drawn into each field's coordinates), uploaded to Blob too.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS pdf_blob_pathname TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS final_pdf_url TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS final_pdf_blob_pathname TEXT;
-- Status enum needs 'declined' for the multi-signer-decline path.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('draft', 'sent', 'completed', 'voided', 'declined'));
-- Documents double as templates: when is_template=TRUE the row is a
-- reusable form template (no recipient, status='draft'). Booking the
-- right service auto-clones it into a new instance addressed to the
-- client. instance.template_id points back to the template so we can
-- show "5 sent in last 30d" stats per template.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS template_id UUID REFERENCES documents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_documents_templates
  ON documents(workspace_id) WHERE is_template = TRUE;
-- Stamps the last time the doc-reminders cron pinged the owner about this
-- still-unsigned document. Used to throttle the nag — once a week max.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS last_overdue_reminder_at TIMESTAMPTZ;
-- Per-service intake-form attachment. UUID[] of document template ids
-- to clone + send when a booking against this service is created.
ALTER TABLE services ADD COLUMN IF NOT EXISTS intake_form_template_ids UUID[] NOT NULL DEFAULT '{}'::uuid[];

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

-- ─── Stripe Tax integration ──────────────────────────────────────────
-- Per-workspace toggle for automatic_tax. When TRUE, Stripe computes
-- VAT / sales tax at checkout from the buyer's address against the
-- connected account's tax-registration matrix (configured by the
-- owner via Stripe Dashboard → Tax). Avoids the workspace having to
-- compute jurisdictional tax themselves — Stripe Tax handles every
-- US state, EU member, UK, Canada GST/HST/PST, etc.
--
-- Off by default — owners must explicitly enable + register tax
-- jurisdictions in Stripe Dashboard before turning this on.
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS stripe_tax_enabled BOOLEAN NOT NULL DEFAULT FALSE;
-- Optional tax behavior override: 'exclusive' (item amounts are pre-
-- tax, Stripe adds tax on top — typical US) or 'inclusive' (item
-- amounts ARE the tax-inclusive total — typical EU). Stripe defaults
-- to exclusive when unset.
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS stripe_tax_behavior TEXT;
ALTER TABLE finance_settings DROP CONSTRAINT IF EXISTS finance_settings_tax_behavior_check;
ALTER TABLE finance_settings ADD CONSTRAINT finance_settings_tax_behavior_check
  CHECK (stripe_tax_behavior IS NULL OR stripe_tax_behavior IN ('inclusive', 'exclusive'));
-- Stripe Connect (OAuth) support. acct_xxx id from the connect/oauth/token
-- exchange. When set, charges + customers are scoped to this connected
-- account via Stripe-Account header — no need to store their secret key.
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS stripe_connect_user_id TEXT;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS stripe_connect_livemode BOOLEAN;
-- Onboarding status for the Account Links (Express) flow:
--   • pending  → Express acct created, owner hasn't finished Stripe-hosted onboarding yet
--   • complete → onboarding finished, charges_enabled=true, ready to receive payments
-- NULL for legacy Standard OAuth rows (those are 'complete' by definition since
-- the OAuth grant is what created the row in the first place).
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS stripe_onboarding_status TEXT
  CHECK (stripe_onboarding_status IS NULL OR stripe_onboarding_status IN ('pending', 'complete'));

-- Multi-processor support. Each workspace picks one provider that
-- handles every owner→client charge. 'stripe' is the default for back-
-- compat with everything that's been live.
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS payment_provider TEXT NOT NULL DEFAULT 'stripe'
  CHECK (payment_provider IN ('stripe', 'square', 'paypal'));

-- Square Connect (OAuth). Owners click Connect → Square → return with
-- the access_token + refresh_token + merchant_id we encrypt and stash.
-- Tokens rotate; the refresh_token outlasts the access token. We use
-- the merchant's first location as the default for checkouts unless
-- they pick another in settings.
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS square_credentials_encrypted TEXT;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS square_merchant_id TEXT;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS square_location_id TEXT;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS square_account_label TEXT;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS square_connected_at TIMESTAMPTZ;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS square_environment TEXT;

-- PayPal Commerce Platform (Partner Referrals). Owners click Connect →
-- PayPal → return with their merchant_id; we don't store an OAuth token
-- because PayPal asks the platform to mint short-lived tokens with its
-- own client_id+secret + the merchant's id (auth-assertion pattern).
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS paypal_merchant_id TEXT;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS paypal_account_label TEXT;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS paypal_connected_at TIMESTAMPTZ;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS paypal_payments_enabled BOOLEAN;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS paypal_environment TEXT;

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

-- Expenses. Owners log deductible business spend with category +
-- optional vendor + notes + receipt URL. Categories map to IRS
-- Schedule C lines so the annual tax export aggregates correctly.
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  date DATE NOT NULL,
  category TEXT NOT NULL,
  vendor TEXT,
  notes TEXT,
  receipt_url TEXT,
  payment_method TEXT,
  is_deductible BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_expenses_workspace_date ON expenses(workspace_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_workspace_category ON expenses(workspace_id, category, date DESC);
-- Tracks the most recent Stripe checkout session per invoice. Webhook lookup
-- uses this to find the invoice when checkout.session.completed fires.
-- Snapshot of what was actually paid, captured at payment time.
-- Distinct from computeTotals(items, tax, discount) which would re-derive
-- against possibly-edited items later. The Stripe / manual / Square /
-- PayPal "mark paid" paths all write this; reports + receipts read it.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_invoices_stripe_session ON invoices(stripe_session_id) WHERE stripe_session_id IS NOT NULL;
-- Refunds. payment_intent gets captured on checkout.session.completed
-- so the refund endpoint can target it. refunded_amount tracks partial
-- refunds — when it equals the total, status flips to 'refunded'.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS stripe_payment_intent TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'voided', 'refunded'));

-- Time tracking. One row per timer entry; the running entry has
-- ended_at = NULL. duration_seconds is computed at stop, or live in
-- the UI from started_at. Once an entry is rolled into an invoice
-- (via /api/time-entries/bill), invoice_id is set and status flips
-- to 'billed' so it doesn't get billed again. Hourly rate is a
-- snapshot at start so changing the default later doesn't rewrite
-- the time you've already tracked.
CREATE TABLE IF NOT EXISTS time_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  description TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  duration_seconds INT,
  hourly_rate NUMERIC(12,2) NOT NULL DEFAULT 0,
  billable BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','stopped','billed')),
  invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_time_entries_workspace
  ON time_entries(workspace_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_time_entries_client
  ON time_entries(client_id, status) WHERE client_id IS NOT NULL;
-- One workspace can only have ONE running entry at a time. Enforced
-- with a partial unique index — keeps the timer UI simple (single
-- start/stop button) without race-condition surprises.
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_one_running
  ON time_entries(workspace_id) WHERE status = 'running';
-- Per-workspace default hourly rate. Stored on finance_settings so
-- new entries can default to it without an extra round trip.
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS default_hourly_rate NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Quotes / estimates. Mirrors invoices for the structural pieces
-- (line items, tax, discount, notes, public view token) but lives
-- in its own table because the LIFECYCLE is different: a quote is
-- proposed, the client accepts or declines, and on accept it
-- becomes an invoice. We never mutate a quote post-acceptance —
-- the resulting invoice carries the snapshot.
CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  client_name TEXT,
  client_email TEXT,
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expiry_date DATE,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  tax_rate NUMERIC(6,3) NOT NULL DEFAULT 0,
  discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'expired', 'voided')),
  view_token_hash TEXT UNIQUE,
  sent_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  decline_reason TEXT,
  -- When accepted, we create an invoice and link it here so the
  -- owner sees "this quote turned into INV-1042" in the activity log.
  resulting_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  activity JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, number)
);
CREATE INDEX IF NOT EXISTS idx_quotes_workspace_status
  ON quotes(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_quotes_workspace_issued
  ON quotes(workspace_id, issue_date DESC);

-- Auto-incrementing quote number (parallels finance_settings.next_invoice_number).
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS next_quote_number INT NOT NULL DEFAULT 1001;

-- Gift cards. Each row is one issued card with a redeemable code.
-- balance_cents drains as the card is applied to bookings/invoices;
-- we never destructively edit history, so the audit trail comes
-- from gift_card_redemptions.
CREATE TABLE IF NOT EXISTS gift_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Public code shown to recipients. 12+ chars, ambiguity-free
  -- (no 0/O/1/I), uppercase. Hashed for lookup so a leaked DB
  -- doesn't immediately give attackers usable codes.
  code_hash TEXT NOT NULL UNIQUE,
  -- Last 4 chars of the raw code for the owner dashboard so they
  -- can identify a row without seeing the full code (which we
  -- can't decrypt). Recipients see the full code via email.
  code_last4 TEXT NOT NULL,
  original_amount_cents INT NOT NULL CHECK (original_amount_cents > 0),
  balance_cents INT NOT NULL CHECK (balance_cents >= 0),
  -- Stripe payment_intent for the purchase, so refunds are possible.
  stripe_payment_intent TEXT,
  sender_name TEXT,
  sender_email TEXT,
  recipient_name TEXT,
  recipient_email TEXT,
  message TEXT,
  -- Optional expiry. Many states cap minimum expiry windows for
  -- gift cards — owners set this per workspace policy. NULL = no
  -- expiry (default).
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'depleted', 'expired', 'voided')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gift_cards_workspace
  ON gift_cards(workspace_id, status, created_at DESC);

-- Append-only audit of every redemption (or partial spend) of a
-- gift card. amount_cents is what came off this card in this
-- transaction. applied_to_kind names the target object so reports
-- can join back ('booking' | 'invoice'); applied_to_id is the
-- target's UUID.
CREATE TABLE IF NOT EXISTS gift_card_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_card_id UUID NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  applied_to_kind TEXT NOT NULL CHECK (applied_to_kind IN ('booking', 'invoice')),
  applied_to_id UUID,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gc_redemptions_card
  ON gift_card_redemptions(gift_card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gc_redemptions_workspace
  ON gift_card_redemptions(workspace_id, created_at DESC);

-- Bookings + invoices both surface their gift-card credit in their
-- own row so reports + receipts include it without a join.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS gift_card_credit_cents INT NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gift_card_credit_cents INT NOT NULL DEFAULT 0;

-- Per-booking link to the invoice generated by the "Collect in person"
-- flow. Letting re-clicks reuse the same draft instead of stacking up
-- duplicate invoices in Finance.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS collect_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL;

-- Memberships: self-serve recurring subscriptions. Owners define
-- one or more "membership" tiers (name, price, perks). Each tier
-- gets a Stripe Product + Price provisioned on the connected
-- account at first save; the public booking page surfaces a
-- "Join the membership" card that opens a Stripe Checkout in
-- subscription mode. Webhook lifecycle (customer.subscription.*)
-- mirrors state into client_memberships.
CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  -- Pricing snapshot. Stored on the row so the displayed price
  -- always matches the Stripe Price (they're created together).
  -- Currency comes from finance_settings.currency.
  price_cents INT NOT NULL CHECK (price_cents >= 0),
  interval TEXT NOT NULL DEFAULT 'month'
    CHECK (interval IN ('week', 'month', 'quarter', 'year')),
  -- Stripe handles. Created on the first save against the connected
  -- account; reused on subsequent membership-checkout calls. NULL
  -- when the workspace hasn't connected Stripe yet — UI gates the
  -- public sign-up flow accordingly.
  stripe_product_id TEXT,
  stripe_price_id TEXT,
  -- Free-form JSONB list of perks (["Unlimited bookings", "10% off products"]).
  perks JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memberships_workspace
  ON memberships(workspace_id, active, display_order);

-- Per-client membership state. One row per (workspace, client,
-- membership) — a client can have multiple historical subscriptions
-- to the same tier (cancelled, re-joined). We DON'T enforce uniqueness
-- on (client, membership) so the audit trail of past tiers is preserved.
CREATE TABLE IF NOT EXISTS client_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  membership_id UUID REFERENCES memberships(id) ON DELETE SET NULL,
  -- Snapshot at sign-up time so the row stays meaningful even if the
  -- owner edits / deletes the underlying tier.
  membership_name TEXT NOT NULL,
  price_cents INT NOT NULL,
  interval TEXT NOT NULL,
  stripe_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'past_due', 'cancelled', 'incomplete')),
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_memberships_workspace
  ON client_memberships(workspace_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_memberships_client
  ON client_memberships(client_id, status);

-- PayPal subscription support (parallel to memberships.stripe_price_id /
-- client_memberships.stripe_subscription_id). A tier can be provisioned on
-- either processor; the provider column records which one a given client
-- membership runs on so renewals/cancels route to the right adapter.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS paypal_plan_id TEXT;
ALTER TABLE client_memberships ADD COLUMN IF NOT EXISTS paypal_subscription_id TEXT;
ALTER TABLE client_memberships ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'stripe';
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_memberships_paypal_sub
  ON client_memberships(paypal_subscription_id) WHERE paypal_subscription_id IS NOT NULL;

-- Recurring invoices. Each row defines a template + schedule that
-- the daily cron uses to mint a fresh invoices row at every interval.
-- The template's items / tax / discount / notes get copied snapshot-
-- style into each generated invoice so the owner can edit the
-- template later without retroactively rewriting issued invoices.
--
-- cadence drives advancement of next_run_at. status='paused' skips
-- runs without ending the schedule; status='ended' closes it. When
-- auto_send is TRUE the generated invoice is sent + emailed
-- automatically; when FALSE it lands as a draft for owner review.
CREATE TABLE IF NOT EXISTS recurring_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  client_name TEXT,
  client_email TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  tax_rate NUMERIC(6,3) NOT NULL DEFAULT 0,
  discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes TEXT,
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly','biweekly','monthly','quarterly','yearly')),
  next_run_at DATE NOT NULL,
  end_date DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  auto_send BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  last_invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
  occurrences_run INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_recurring_invoices_workspace
  ON recurring_invoices(workspace_id, status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_recurring_invoices_due
  ON recurring_invoices(next_run_at) WHERE status = 'active';

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

-- Global platform settings. Singleton row (id = 1) holds toggles that
-- aren't workspace-scoped — currently just the temporary "early access"
-- password gate that blocks signup/signin until the admin disables it.
-- When early_access_enabled = TRUE, the auth endpoints require a valid
-- gate cookie; otherwise normal flow.
CREATE TABLE IF NOT EXISTS app_settings (
  id INT PRIMARY KEY DEFAULT 1,
  early_access_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  early_access_password_hash TEXT,
  early_access_updated_at TIMESTAMPTZ,
  CONSTRAINT app_settings_singleton CHECK (id = 1)
);
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Project / engagement layer. Groups bookings + invoices + quotes +
-- documents under a named engagement so project-based service providers
-- (photographers, designers, consultants) can see "Smith wedding" as
-- a single unit rather than three loose artifacts against the Smith
-- client row. Session-based providers (trainers, stylists) can ignore
-- this surface — every artifact remains workable without a project.
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
  color TEXT,
  starts_at DATE,
  ends_at DATE,
  amount_quoted NUMERIC(12,2),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace_client
  ON projects(workspace_id, client_id);
CREATE INDEX IF NOT EXISTS idx_projects_workspace_status_updated
  ON projects(workspace_id, status, updated_at DESC);

-- Optional artifact → project link. ON DELETE SET NULL so deleting a
-- project doesn't cascade-delete invoices/bookings/docs underneath.
ALTER TABLE bookings  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE invoices  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE quotes    ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_project  ON bookings(project_id)  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_project  ON invoices(project_id)  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_quotes_project    ON quotes(project_id)    WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id) WHERE project_id IS NOT NULL;

-- Workflows / automation. Owner defines a rule: "when X happens, do Y."
--
-- trigger_type values (v1):
--   lead_created      — a client was inserted with stage='lead'
--   client_created    — any new client row
--   client_inactive   — client has not had a booking in trigger_config.daysInactive days
--   booking_completed — a booking's end time has passed and it wasn't cancelled
--
-- actions is an array. Each entry shape:
--   { type: 'send_email' | 'send_sms' | 'create_task' | 'send_document',
--     config: { subject?, body?, taskTitle?, templateId?, ... } }
--
-- Tokens supported in body/subject text: {{firstName}}, {{clientName}},
-- {{businessName}}, {{ownerName}}. Resolved at execution time.
CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL
    CHECK (trigger_type IN ('lead_created', 'client_created', 'client_inactive', 'booking_completed')),
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflows_workspace_trigger
  ON workflows(workspace_id, trigger_type) WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_workflows_workspace_updated
  ON workflows(workspace_id, updated_at DESC);

-- Audit log for each workflow execution. Lets owners see "did the
-- birthday email actually go out?" without grepping server logs.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped', 'partial', 'waiting', 'stopped')),
  action_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow
  ON workflow_runs(workflow_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace
  ON workflow_runs(workspace_id, triggered_at DESC);
-- Dedupe: prevent firing the same workflow twice for the same client on
-- the same calendar day (saves an email storm if a row gets touched
-- multiple times). Soft constraint — the executor checks before insert.
-- Anchored to UTC so the date cast is IMMUTABLE (a bare ::date cast
-- depends on session timezone and Postgres rejects it in index
-- expressions).
CREATE INDEX IF NOT EXISTS idx_workflow_runs_dedupe
  ON workflow_runs(workflow_id, client_id, ((triggered_at AT TIME ZONE 'UTC')::date))
  WHERE client_id IS NOT NULL;
-- Update the status CHECK constraint on existing workflow_runs rows so
-- previously-deployed databases accept the new 'waiting' + 'stopped'
-- statuses. CREATE TABLE IF NOT EXISTS won't refresh the constraint.
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_status_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_status_check
  CHECK (status IN ('succeeded', 'failed', 'skipped', 'partial', 'waiting', 'stopped'));

-- Deferred-action queue for workflows that include a wait_step. When
-- a workflow's action list hits a wait_step, we stop executing,
-- snapshot the client + remaining context, and INSERT a row here with
-- resume_at = NOW() + the wait interval. The workflows cron picks up
-- rows where resume_at <= NOW() and resumes the workflow from
-- next_action_index.
--
-- client_snapshot stores name/email/phone/sms_consent_at because the
-- live clients row may have changed between schedule and resume
-- (renamed, opted-out of SMS, etc.) — we resume against the snapshot
-- so the message reads consistently with what the owner approved.
CREATE TABLE IF NOT EXISTS workflow_pending_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  client_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  next_action_index INT NOT NULL DEFAULT 0,
  resume_at TIMESTAMPTZ NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workflow_pending_resume
  ON workflow_pending_runs(resume_at);
CREATE INDEX IF NOT EXISTS idx_workflow_pending_workflow
  ON workflow_pending_runs(workflow_id);

-- Multi-staff / chair rental. Workspace owners who hire (or share
-- chair space with) other practitioners can model each as a staff_member
-- row. Bookings get a staff_id so each practitioner's calendar can be
-- filtered independently. user_id is optional — staff who claim a
-- portal account get linked so they can see their own appointments
-- via /me. owner_managed=TRUE means the workspace owner inputs all
-- changes (no portal login needed); FALSE means the staff member has
-- their own login (future v2).
CREATE TABLE IF NOT EXISTS staff_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT,
  color TEXT,
  hourly_rate NUMERIC(12,2),
  commission_rate NUMERIC(5,2),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  owner_managed BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_members_workspace
  ON staff_members(workspace_id, active);
CREATE INDEX IF NOT EXISTS idx_staff_members_user
  ON staff_members(user_id) WHERE user_id IS NOT NULL;

-- Optional staff assignment on each booking. NULL = owner (the
-- workspace's original solo practitioner). The Calendar UI lets the
-- owner filter by staff_id to see one practitioner's schedule at a time.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS staff_id UUID
  REFERENCES staff_members(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_staff_date
  ON bookings(workspace_id, staff_id, date) WHERE staff_id IS NOT NULL;

-- Onboarding progress per user. Tracks which step they're on, which
-- steps they've finished, and which they explicitly skipped. The actual
-- form data (business name, services, etc.) lives in its real table
-- (calendar_settings, services, etc.) — this column only tracks the
-- wizard's navigational state so we can resume mid-flow.
--
-- Shape:
--   {
--     currentStep: 'services',
--     completedSteps: ['welcome', 'business'],
--     skippedSteps: ['branding'],
--     lastActiveAt: '2026-...'
--   }
--
-- Dismissed checklist items (post-onboarding) also live here so the
-- dashboard "Finish setting up" card doesn't keep nagging once an
-- owner waves off a recommendation.
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_state JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ─── Performance indexes added 2026-05 after a query audit ───────────
-- Each one targets a frequently-run query that was either doing a
-- partial-index miss or a table scan. Single-column FK indexes also
-- speed up cascades on workspace/client/user deletes.

-- hasConflict() runs on every booking attempt. Without start_min/end_min
-- in the index, it filtered by (workspace_id, date) then did an in-memory
-- range scan on the rest. The partial index excludes cancelled bookings
-- so it stays tight as the table grows. Includes service_id so the
-- group-capacity check ("same slot, same service") is index-served too.
CREATE INDEX IF NOT EXISTS idx_bookings_slot_lookup
  ON bookings(workspace_id, date, start_min, end_min, service_id)
  WHERE cancelled_at IS NULL;

-- Client-side query "show me my bookings" + per-client metrics aggregation.
CREATE INDEX IF NOT EXISTS idx_bookings_client
  ON bookings(client_id) WHERE client_id IS NOT NULL;

-- Service-cascade: ON DELETE SET NULL on services scans bookings without
-- this. Also speeds up "all bookings for this service" reports.
CREATE INDEX IF NOT EXISTS idx_bookings_service
  ON bookings(service_id) WHERE service_id IS NOT NULL;

-- doc-reminders cron filters (status='sent') AND (sent_at <= NOW() - 3 days).
-- The existing (workspace_id, status) index helps per-workspace queries
-- but the cron scans across workspaces; the time-range filter became a
-- full scan over all 'sent' docs. Partial index keyed on sent_at sorts
-- exactly what the cron asks for.
CREATE INDEX IF NOT EXISTS idx_documents_sent_pending
  ON documents(sent_at)
  WHERE status = 'sent' AND sent_at IS NOT NULL;

-- documents.recipient_client_id is used by /api/clients/analytics + the
-- doc-reminders cron's per-client signer lookup. Partial because most
-- legacy single-signer docs leave this NULL.
CREATE INDEX IF NOT EXISTS idx_documents_recipient_client
  ON documents(recipient_client_id) WHERE recipient_client_id IS NOT NULL;

-- /api/finance dashboard rollups filter invoices by paid_at >= start-of-
-- month / start-of-year. Without an index the rollup scans every paid
-- invoice in the workspace. Partial because draft/sent rows always have
-- NULL paid_at.
CREATE INDEX IF NOT EXISTS idx_invoices_workspace_paid_at
  ON invoices(workspace_id, paid_at DESC)
  WHERE paid_at IS NOT NULL;

-- /api/clients lookups by email (used by AddBookingModal to resolve a
-- name typed in by the owner, and by the public-booking flow to merge
-- a recurring client). Email is normalized lowercase at write time so
-- the index doesn't need a LOWER() expression.
CREATE INDEX IF NOT EXISTS idx_clients_workspace_email
  ON clients(workspace_id, email) WHERE email IS NOT NULL;

-- ─── Global search (Cmd+K) trigram indexes ──────────────────────────
-- /api/search runs leading-wildcard ILIKE '%q%' across clients,
-- invoices, and bookings. Without trigram GIN indexes those are full
-- sequential scans per keystroke per workspace — fine at hundreds of
-- rows, multi-hundred-ms at thousands. pg_trgm is already enabled
-- above (idx_services_name_trgm). gin_trgm_ops makes '%foo%' index-
-- backed. We index the columns search actually filters on.
CREATE INDEX IF NOT EXISTS idx_clients_name_trgm
  ON clients USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_clients_email_trgm
  ON clients USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_invoices_clientname_trgm
  ON invoices USING gin (client_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_invoices_number_trgm
  ON invoices USING gin (number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_bookings_clientname_trgm
  ON bookings USING gin (client_name gin_trgm_ops);

-- Dunning cron + admin scans filter workspaces by past-due state across
-- ALL tenants. A partial index keeps that a small index scan instead of
-- a full workspaces seq-scan as the tenant count grows.
CREATE INDEX IF NOT EXISTS idx_workspaces_dunning
  ON workspaces(subscription_past_due_since)
  WHERE subscription_status = 'past_due' AND subscription_suspended_at IS NULL;

-- ─── Multi-currency invoicing ────────────────────────────────────────
-- Until now every invoice was implicitly USD (the platform shipped
-- US-first). Going global requires per-invoice currency stamped at
-- creation time — owners might invoice some clients in USD, others
-- in EUR. Default copied from workspace's finance_settings.currency
-- so existing workflows don't change; explicit override per invoice.
--
-- Codes are ISO 4217 (USD, EUR, GBP, ...). 3-char check enforces
-- shape; no list-membership check at the DB level — payment
-- providers will reject anything they don't support.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_currency_format;
ALTER TABLE invoices ADD CONSTRAINT invoices_currency_format
  CHECK (currency ~ '^[A-Z]{3}$');

-- Recurring templates and quotes too — same logic, copy from
-- workspace default at creation.
ALTER TABLE recurring_invoices ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';

-- ─── Materialized invoice total (Phase S1 §1.2) ─────────────────────
-- The /api/finance dashboard used to expand jsonb_array_elements(items)
-- for every invoice in the workspace, per page load. At 1K invoices the
-- response was already in the seconds; at 10K it became unusable. New
-- column total is kept in sync by a BEFORE-trigger, so every callsite
-- that does an INSERT/UPDATE on items/tax_rate/discount stays unchanged.
-- The dashboard query becomes a single SUM(total) FILTER (WHERE status=...).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS total NUMERIC(12,2) NOT NULL DEFAULT 0;

-- plpgsql is in the default extension set on Neon; no CREATE EXTENSION
-- needed. CREATE OR REPLACE is idempotent across migrator passes.
CREATE OR REPLACE FUNCTION invoices_compute_total() RETURNS trigger AS $$
DECLARE
  v_subtotal numeric;
BEGIN
  SELECT COALESCE(SUM((it->>'quantity')::numeric * (it->>'rate')::numeric), 0)
    INTO v_subtotal
    FROM jsonb_array_elements(COALESCE(NEW.items, '[]'::jsonb)) it;
  NEW.total := ROUND(
    GREATEST(v_subtotal - COALESCE(NEW.discount, 0), 0)
    * (1 + COALESCE(NEW.tax_rate, 0) / 100),
    2
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- DROP-then-CREATE keeps the trigger definition fresh if we ever tweak
-- the function signature; without the drop, ADD TRIGGER would silently
-- be skipped on second run because Postgres has no IF NOT EXISTS for
-- triggers (until v14, partial support since).
DROP TRIGGER IF EXISTS invoices_total_trg ON invoices;
CREATE TRIGGER invoices_total_trg
  BEFORE INSERT OR UPDATE OF items, tax_rate, discount ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_compute_total();

-- One-time backfill for rows written before the trigger existed. The
-- 0-default guarantees the column is populated; this corrects any rows
-- still at zero where items would compute non-zero. Bumping items =
-- items triggers the recompute. Safe on re-runs: rows already correct
-- get recomputed to the same value.
UPDATE invoices SET items = items
WHERE total = 0 AND items <> '[]'::jsonb;

-- Money-sanity CHECKs. The app layer (finance.js / recurring.js)
-- already enforces these, but a DB-level guard stops a buggy or direct
-- write from storing negative money / an out-of-range tax rate.
-- gift_cards / memberships already carry their own non-negative CHECKs;
-- invoices did not. Added NOT VALID so a populated table with any
-- legacy out-of-range row can't block the migration — the constraint
-- still enforces on every INSERT/UPDATE from here on.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_amounts_nonneg;
ALTER TABLE invoices ADD CONSTRAINT invoices_amounts_nonneg
  CHECK (
    discount >= 0
    AND COALESCE(paid_amount, 0) >= 0
    AND refunded_amount >= 0
    AND total >= 0
    AND tax_rate >= 0 AND tax_rate <= 100
  ) NOT VALID;

-- ─── Scaling-readiness composite indexes (Phase S2) ──────────────────
-- These narrow hot-path scans that previously fell back to broader
-- indexes + post-filter. Each one closes a specific bottleneck the
-- thousands-of-users audit surfaced (see plan, §2.6).

-- booking-reminders cron + calendar window queries filter active
-- bookings by date. Existing idx_bookings_workspace_date doesn't have
-- the cancelled_at predicate, so at 1M+ rows the cron does extra index
-- scans. Partial index excludes cancelled rows entirely.
CREATE INDEX IF NOT EXISTS idx_bookings_ws_date_active
  ON bookings(workspace_id, date)
  WHERE cancelled_at IS NULL;

-- invoice-overdue cron filters by (status='sent'|'overdue', due_date
-- < today). Existing idx_invoices_workspace_status doesn't include
-- due_date, so it scans every sent invoice to find the overdue subset.
CREATE INDEX IF NOT EXISTS idx_invoices_ws_status_due
  ON invoices(workspace_id, status, due_date)
  WHERE status IN ('sent', 'overdue');

-- /api/me pending-docs count and /api/me/documents both filter
-- (recipient_client_id, status='sent'). Existing
-- idx_documents_recipient_client doesn't include status.
CREATE INDEX IF NOT EXISTS idx_documents_recipient_status
  ON documents(recipient_client_id, status)
  WHERE recipient_client_id IS NOT NULL;

-- The pending-reviews count in /api/me runs a NOT EXISTS subquery
-- against reviews keyed by booking_id. Without an index the planner
-- does a nested loop scan, which becomes O(N×M) at scale.
CREATE INDEX IF NOT EXISTS idx_reviews_booking
  ON reviews(booking_id);

-- workflows.js evaluator query: filter by trigger_type AND enabled.
-- Existing idx_workflows_workspace_trigger doesn't filter by enabled,
-- so disabled workflows still get scanned at every cron tick.
CREATE INDEX IF NOT EXISTS idx_workflows_enabled_trigger
  ON workflows(trigger_type)
  WHERE enabled = TRUE;

-- ─── Webhook event deduplication (§2.7) ──────────────────────────────
-- Today each webhook handler checks application state ("is the invoice
-- already paid?") to decide whether to skip a duplicate event. Fine at
-- low volume; race-prone when the handler crashes mid-write and the
-- provider retries. Now every handler INSERTs a row keyed by
-- (provider, event_id) at the top of the request; ON CONFLICT DO
-- NOTHING short-circuits the second attempt.
CREATE TABLE IF NOT EXISTS webhook_event_dedup (
  provider     TEXT        NOT NULL,
  event_id     TEXT        NOT NULL,
  workspace_id UUID,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, event_id)
);
-- Retention sweep filters by processed_at < NOW() - 90 days.
CREATE INDEX IF NOT EXISTS idx_webhook_event_dedup_processed
  ON webhook_event_dedup(processed_at);

-- ─── Per-workspace daily usage counters (§2.8) ───────────────────────
-- Caps the blast radius of an abusive / compromised workspace: one
-- rogue owner cannot burn the shared Resend or Twilio sender
-- reputation by spamming. Counter increments atomically via
-- INSERT ... ON CONFLICT DO UPDATE so parallel sends from the same
-- workspace race-safely on the row. Keyed by (workspace_id,
-- counter_key, day) so historical counts stay around for the admin
-- dashboard; a retention cron prunes rows older than 90 days.
CREATE TABLE IF NOT EXISTS daily_usage_counters (
  workspace_id UUID    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  counter_key  TEXT    NOT NULL,
  day          DATE    NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, counter_key, day)
);
-- Retention sweep filters by day < CURRENT_DATE - 90.
CREATE INDEX IF NOT EXISTS idx_daily_usage_counters_day
  ON daily_usage_counters(day);

-- ─── Client-side idempotency records ─────────────────────────────────
-- Lets POST endpoints accept an Idempotency-Key header (matches
-- Stripe's contract). First call: handler runs, response cached.
-- Retries within TTL: cached response returned without re-running
-- the handler. Prevents network-retry storms from creating
-- duplicate bookings / invoices / messages.
--
-- Scoped by (user_id_or_anon, key) so two tenants can't collide
-- on the same key. Pruned at 24h+grace by the db-prune cron.
CREATE TABLE IF NOT EXISTS idempotency_records (
  scope            TEXT        NOT NULL,
  key              TEXT        NOT NULL,
  request_hash     TEXT,
  response_status  INTEGER,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_records_created
  ON idempotency_records(created_at);

-- ─── Cron run history (observability) ────────────────────────────────
-- Every cron stamps a row here on completion. The admin dashboard
-- reads from this to chart per-cron runtime, success/failure rate,
-- and "items processed" — without it, the only way to debug a
-- slow/failing cron at scale is to grep Vercel function logs.
-- Pruned by the db-prune cron at 30 days (crons fire daily; 30 runs
-- per cron is enough for trend spotting without ballooning the table).
CREATE TABLE IF NOT EXISTS cron_runs (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  duration_ms   INTEGER,
  ok            BOOLEAN,
  metrics       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_name_finished
  ON cron_runs(name, finished_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_cron_runs_finished
  ON cron_runs(finished_at DESC NULLS LAST);

-- ─── Schema migration history ────────────────────────────────────────
-- The migrator (api/admin/migrate.js) applies every statement in this
-- file on every run. To get observability without changing the
-- idempotent-ALTER pattern, we record each statement's SHA + apply
-- result here. Re-runs skip statements whose hash already shows
-- applied=true; changed statements (the SHA changed because someone
-- edited them) get retried. Failures stamp last_attempted_at + the
-- error message so admin can see exactly which statement is stuck.
--
-- Bootstrap: this table itself is in the schema, so on a brand-new DB
-- the migrator can't reference it until after its own statement
-- applies. The migrator handles that — wraps the bookkeeping insert
-- in try/catch and silently skips if the table doesn't exist yet.
CREATE TABLE IF NOT EXISTS schema_migrations (
  statement_hash   TEXT PRIMARY KEY,
  first_applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  apply_count      INTEGER NOT NULL DEFAULT 1,
  applied          BOOLEAN NOT NULL,
  error_message    TEXT,
  statement_preview TEXT
);
CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied
  ON schema_migrations(applied, last_attempt_at DESC);

-- ─── Discover page precomputed snapshot ──────────────────────────────
-- /api/me/discover used to run ~8 subqueries per workspace in the
-- result (service_count, min/max_price, cover_photo_url, site_handle,
-- review_count, rating_avg, services aggregation). At 200 results
-- that's 1600 subqueries per page load.
--
-- This table caches the static-derived fields, refreshed by the
-- discover-refresh cron every 15 min. The discover endpoint now
-- JOINs this instead of running the subqueries.
--
-- 15-min staleness window is acceptable for a directory page — when
-- an owner adds a service, it appears in discover by the next
-- refresh.
CREATE TABLE IF NOT EXISTS discover_snapshots (
  workspace_id   UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  service_count  INTEGER NOT NULL DEFAULT 0,
  min_price      NUMERIC,
  max_price      NUMERIC,
  cover_photo_url TEXT,
  site_handle    TEXT,
  review_count   INTEGER NOT NULL DEFAULT 0,
  rating_avg     NUMERIC,
  refreshed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_discover_snapshots_refreshed
  ON discover_snapshots(refreshed_at);
`;
