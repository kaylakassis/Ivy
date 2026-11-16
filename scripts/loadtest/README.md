# Load test: 2,000 businesses

A local test of the real API code against a database sized like 2,000
businesses (about 335,000 clients, 1.3 million bookings, 230,000 invoices,
890,000 messages). All data is made up by `seed.sql`; nothing real is used.
Email, texts, payments and AI are answered by a stand-in, so nothing leaves
the machine.

What it can tell you: slow queries, screens that make too many database
round trips, scheduled jobs that cannot finish in one run, and how the code
behaves with many people at once.

What it cannot tell you: anything about the real hosting (the hosted
database's plan and limits, cold starts, the email provider's limits). That
needs a run against a staging copy of the real setup.

## Run it

Needs a local Postgres with the `pg_trgm` extension available.

```bash
# 1. a database of its own, with the app's real schema
createdb ivy_load            # then: CREATE EXTENSION pg_trgm; in it
DATABASE_URL=postgres://USER:PASS@localhost:5432/ivy_load \
  node --import ./tests/bootstrap.mjs scripts/migrate.mjs

# 2. the made-up data (takes a few minutes; :hash is any bcrypt hash)
psql postgres://USER:PASS@localhost:5432/ivy_load -v hash="'<bcrypt hash>'" -f scripts/loadtest/seed.sql
#    then give every business an invoice counter above the seeded numbers:
#    INSERT INTO finance_settings (workspace_id, next_invoice_number) SELECT id, 5000 FROM workspaces ON CONFLICT (workspace_id) DO UPDATE SET next_invoice_number = 5000;

# 3. servers (three, to use three cores), from the repo root
for p in 5500 5501 5502; do
  LOAD_DB=postgres://USER:PASS@localhost:5432/ivy_load PORT=$p \
    node --import ./scripts/loadtest/bootstrap.mjs scripts/loadtest/server.mjs &
done

# 4a. every request on its own: time, database time, number of queries
PORTS=5500 node scripts/loadtest/gen.mjs profile
# 4b. mixed traffic at 25, 50, 100 and 200 people at once, 25 seconds each
PORTS=5500,5501,5502 node scripts/loadtest/gen.mjs ramp 25,50,100,200 25
# 4c. every scheduled job once, timed
node scripts/loadtest/crons.mjs 5500
```

Useful switches on the server: `DB_HOP_MS=80` adds a delay to every query,
to show what a request costs when the database is far from the server
(for example a server in Europe and a database in the US). `PROVIDER_MS`
sets how long the stand-in email provider takes to answer (default 120).

## What the first run found (November 2026)

- No failures up to 200 people at once; no single slow query.
- The public booking page and the dashboard asked the database one question
  after another (about 16 and 14 in a row). Both now ask side by side.
- With a far-away database, every request pays for each round trip. Keep the
  servers in the same region as the database.
- The Monday recap could not reach all 2,000 owners in one run; it now runs
  four times an hour apart.
- An email the provider rate-limited was dropped; it is now retried.
