-- Synthetic data for the load test: 2,000 businesses, sized like real solo
-- businesses, with every 50th one unusually large (2,000 clients) to
-- stress the worst case. Nothing here is real customer data.
--   psql -v hash="'<bcrypt>'" -f seed.sql
\set ON_ERROR_STOP on
\timing on
SET synchronous_commit = off;

-- how many of each thing business n has
CREATE OR REPLACE FUNCTION load_clients(n int)  RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN n % 50 = 0 THEN 2000 ELSE 40 + (n % 7) * 30 END $$;
CREATE OR REPLACE FUNCTION load_bookings(n int) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN n % 50 = 0 THEN 3000 ELSE 300 + (n % 5) * 150 END $$;
CREATE OR REPLACE FUNCTION load_invoices(n int) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN n % 50 = 0 THEN 600 ELSE 60 + (n % 4) * 30 END $$;
CREATE OR REPLACE FUNCTION load_name(k int) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT (ARRAY['Ava','Liam','Mia','Noah','Zoe','Ethan','Ivy','Lucas','Nora','Owen','Ruby','Caleb','Elena','Felix','Grace','Hugo','Isla','Jonas','Kira','Leo'])[1 + k % 20]
      || ' ' || (ARRAY['Rivera','Chen','Patel','Lopez','Kim','Nguyen','Brooks','Hart','Silva','Morgan','Reed','Shah','Novak','Okafor','Bauer','Costa','Dunn','Ellis','Frost','Garcia'])[1 + (k / 20) % 20]
      || CASE WHEN k >= 400 THEN ' ' || (k / 400)::text ELSE '' END $$;

-- owners
INSERT INTO users (id, email, password_hash, name, email_verified_at, terms_version, terms_accepted_at, privacy_version, privacy_accepted_at,
                   last_login_at, last_active_at, user_type, account_email_consent_at, created_at)
SELECT md5('owner' || n)::uuid, 'load-owner-' || n || '@example.com', :hash, 'Owner ' || n, now() - interval '200 days',
       '2026-05-05', now() - interval '200 days', '2026-11-05', now() - interval '5 days',
       now() - (n % 48) * interval '1 hour', now() - (n % 48) * interval '1 hour', 'regular', now() - interval '200 days',
       now() - (200 + n % 160) * interval '1 day'
  FROM generate_series(1, 2000) n;

INSERT INTO workspaces (id, owner_id, name, created_at, onboarded_at, business_type, subscription_status, trial_started_at, trial_ends_at,
                        subscription_period_end, subscription_source, converted_at)
SELECT md5('ws' || n)::uuid, md5('owner' || n)::uuid, 'Load Studio ' || n, now() - (200 + n % 160) * interval '1 day',
       now() - (199 + n % 160) * interval '1 day', 'both',
       CASE WHEN n % 40 = 0 THEN 'trialing' WHEN n % 97 = 0 THEN 'past_due' ELSE 'active' END,
       now() - (199 + n % 160) * interval '1 day', now() - (185 + n % 160) * interval '1 day',
       now() + (1 + n % 28) * interval '1 day', 'stripe', now() - (185 + n % 160) * interval '1 day'
  FROM generate_series(1, 2000) n;

INSERT INTO calendar_settings (workspace_id, biz_name, slug, availability, timezone, discoverable, category, tagline)
SELECT md5('ws' || n)::uuid, 'Load Studio ' || n, 'load-biz-' || n,
       '{"0": [], "1": [{"end": 1020, "start": 540}], "2": [{"end": 1020, "start": 540}], "3": [{"end": 1020, "start": 540}], "4": [{"end": 1020, "start": 540}], "5": [{"end": 840, "start": 540}], "6": []}'::jsonb,
       (ARRAY['America/New_York','America/Chicago','America/Los_Angeles','Europe/London'])[1 + n % 4],
       n % 5 = 0, (ARRAY['wellness','beauty','fitness','health','professional'])[1 + n % 5], 'Appointments in studio ' || n
  FROM generate_series(1, 2000) n;

INSERT INTO services (id, workspace_id, name, duration_minutes, price, display_order)
SELECT md5('svc' || n || '-' || k)::uuid, md5('ws' || n)::uuid,
       (ARRAY['Signature session','Intro call','Deep work','Quick follow-up'])[k], (ARRAY[60, 30, 90, 45])[k], (ARRAY[85, 0, 140, 55])[k], k
  FROM generate_series(1, 2000) n, generate_series(1, 4) k;

-- clients
INSERT INTO clients (id, workspace_id, name, email, phone, stage, tags, lifetime_value, source, joined_at, last_seen_at, created_at)
SELECT md5('cl' || n || '-' || k)::uuid, md5('ws' || n)::uuid, load_name(k), 'c' || k || '.w' || n || '@example.com',
       '+1512555' || lpad((k % 10000)::text, 4, '0'),
       CASE WHEN k % 9 = 0 THEN 'lead' WHEN k % 31 = 0 THEN 'paused' ELSE 'active' END,
       CASE WHEN k % 4 = 0 THEN ARRAY['vip'] WHEN k % 6 = 0 THEN ARRAY['monthly'] ELSE ARRAY[]::text[] END,
       (k % 40) * 60, (ARRAY['referral','instagram','website','walk-in'])[1 + k % 4],
       now() - (10 + (k * 7) % 330) * interval '1 day', now() - ((k * 3) % 120) * interval '1 day', now() - (10 + (k * 7) % 330) * interval '1 day'
  FROM generate_series(1, 2000) n CROSS JOIN LATERAL generate_series(1, load_clients(n)) k;

-- five clients of every business have their own portal sign-in
INSERT INTO users (id, email, password_hash, name, email_verified_at, terms_version, terms_accepted_at, privacy_version, privacy_accepted_at, last_login_at, user_type, account_email_consent_at)
SELECT md5('cu' || n || '-' || k)::uuid, 'c' || k || '.w' || n || '@example.com', :hash, load_name(k), now() - interval '90 days',
       '2026-05-05', now() - interval '90 days', '2026-11-05', now() - interval '5 days', now() - (k % 20) * interval '1 day', 'regular', now() - interval '90 days'
  FROM generate_series(1, 2000) n, generate_series(1, 5) k;
UPDATE clients c SET user_id = md5('cu' || s.n || '-' || s.k)::uuid
  FROM (SELECT n, k FROM generate_series(1, 2000) n, generate_series(1, 5) k) s
 WHERE c.id = md5('cl' || s.n || '-' || s.k)::uuid;

-- bookings: the last 180 days and the next 30
INSERT INTO bookings (id, workspace_id, service_id, client_id, client_name, client_email, client_phone, date, start_min, end_min,
                      cancelled_at, created_at, updated_at, booking_total, source, booked_via)
SELECT md5('bk' || n || '-' || j)::uuid, md5('ws' || n)::uuid, md5('svc' || n || '-' || (1 + j % 4))::uuid,
       md5('cl' || n || '-' || (1 + (j * 13) % load_clients(n)))::uuid, load_name(1 + (j * 13) % load_clients(n)),
       'c' || (1 + (j * 13) % load_clients(n)) || '.w' || n || '@example.com', '+1512555' || lpad(((1 + (j * 13) % load_clients(n)) % 10000)::text, 4, '0'),
       d.day, 540 + (j % 16) * 30, 540 + (j % 16) * 30 + (ARRAY[60, 30, 90, 45])[1 + j % 4],
       CASE WHEN j % 23 = 0 THEN d.day - interval '2 days' END, d.day - interval '9 days', d.day - interval '9 days',
       (ARRAY[85, 0, 140, 55])[1 + j % 4], 'client', 'booking_page'
  FROM generate_series(1, 2000) n
 CROSS JOIN LATERAL generate_series(1, load_bookings(n)) j
 CROSS JOIN LATERAL (SELECT (current_date - 180 + ((j::bigint * 210) / load_bookings(n))::int) AS day) d;

-- invoices over the last year
INSERT INTO invoices (id, workspace_id, number, client_id, client_name, client_email, issue_date, due_date, items, tax_rate, discount, status,
                      sent_at, paid_at, paid_method, paid_amount, total, currency, created_at, updated_at)
SELECT md5('inv' || n || '-' || i)::uuid, md5('ws' || n)::uuid, 'INV-' || (1000 + i),
       md5('cl' || n || '-' || (1 + (i * 7) % load_clients(n)))::uuid, load_name(1 + (i * 7) % load_clients(n)),
       'c' || (1 + (i * 7) % load_clients(n)) || '.w' || n || '@example.com',
       d.day, d.day + 14,
       jsonb_build_array(jsonb_build_object('id', 'li1', 'description', 'Signature session', 'quantity', 1 + i % 3, 'rate', 85)),
       0, 0, s.status,
       CASE WHEN s.status <> 'draft' THEN d.day + interval '10 hours' END,
       CASE WHEN s.status = 'paid' THEN d.day + interval '3 days' END,
       CASE WHEN s.status = 'paid' THEN (ARRAY['card','cash','zelle'])[1 + i % 3] END,
       CASE WHEN s.status = 'paid' THEN (1 + i % 3) * 85 END,
       (1 + i % 3) * 85, 'USD', d.day, d.day + interval '3 days'
  FROM generate_series(1, 2000) n
 CROSS JOIN LATERAL generate_series(1, load_invoices(n)) i
 CROSS JOIN LATERAL (SELECT (current_date - 360 + ((i::bigint * 360) / load_invoices(n))::int) AS day) d
 CROSS JOIN LATERAL (SELECT CASE WHEN i % 20 = 0 THEN 'draft'
                                 WHEN i > load_invoices(n) - 4 THEN 'sent'
                                 WHEN i % 20 = 3 AND d.day + 14 < current_date THEN 'overdue'
                                 ELSE 'paid' END AS status) s;

-- a conversation with every third client, eight messages each
INSERT INTO message_threads (id, workspace_id, client_id, mode, unread_biz, unread_client, last_message_at, last_message_preview, created_at)
SELECT md5('th' || n || '-' || k)::uuid, md5('ws' || n)::uuid, md5('cl' || n || '-' || k)::uuid, 'two-way',
       CASE WHEN k % 12 = 0 THEN 1 ELSE 0 END, 0, now() - ((k * 5) % 90) * interval '1 day', 'See you then, thanks!', now() - interval '120 days'
  FROM generate_series(1, 2000) n CROSS JOIN LATERAL generate_series(3, load_clients(n), 3) k;

INSERT INTO messages (thread_id, sender, text, kind, created_at)
SELECT md5('th' || n || '-' || k)::uuid, CASE WHEN m % 2 = 0 THEN 'biz' ELSE 'client' END,
       (ARRAY['Hi! Could we move my appointment to Thursday?','Of course. I have 2:30 or 4:00 open.','2:30 works, thank you.','Booked. See you then!',
              'Quick question about the invoice you sent.','Happy to help. Which line?','The second one. Is that the package?','Yes, that is the 3-session package.'])[m],
       'text', now() - ((k * 5) % 90) * interval '1 day' - (8 - m) * interval '7 minutes'
  FROM generate_series(1, 2000) n CROSS JOIN LATERAL generate_series(3, load_clients(n), 3) k, generate_series(1, 8) m;

-- owner notifications, reviews, expenses
INSERT INTO notifications (user_id, workspace_id, type, title, body, url, read_at, created_at)
SELECT md5('owner' || n)::uuid, md5('ws' || n)::uuid, (ARRAY['bookings','payments','engagement'])[1 + x % 3],
       (ARRAY['New booking','Invoice paid','A client has gone quiet'])[1 + x % 3], load_name(x) || ' · Signature session', '/calendar',
       CASE WHEN x > 6 THEN now() - x * interval '1 day' END, now() - x * interval '18 hours'
  FROM generate_series(1, 2000) n, generate_series(1, 40) x;

INSERT INTO reviews (workspace_id, client_id, reviewer_name, rating, text, status, created_at)
SELECT md5('ws' || n)::uuid, md5('cl' || n || '-' || r)::uuid, load_name(r), 4 + r % 2, 'Calm, professional and always on time.', 'visible', now() - r * interval '11 days'
  FROM generate_series(1, 2000) n, generate_series(1, 8) r;

INSERT INTO expenses (workspace_id, amount, date, category, vendor, payment_method, is_deductible)
SELECT md5('ws' || n)::uuid, 20 + (e * 7) % 180, current_date - e * 9, (ARRAY['supplies','rent','software','travel'])[1 + e % 4], 'Vendor ' || (e % 9), 'card', true
  FROM generate_series(1, 2000) n, generate_series(1, 30) e;

ANALYZE;
SELECT 'users' t, count(*) FROM users UNION ALL SELECT 'workspaces', count(*) FROM workspaces UNION ALL SELECT 'clients', count(*) FROM clients
UNION ALL SELECT 'bookings', count(*) FROM bookings UNION ALL SELECT 'invoices', count(*) FROM invoices UNION ALL SELECT 'threads', count(*) FROM message_threads
UNION ALL SELECT 'messages', count(*) FROM messages UNION ALL SELECT 'notifications', count(*) FROM notifications;
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;
