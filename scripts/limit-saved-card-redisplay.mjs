// One-off backfill: keep cards that were ALREADY saved off Stripe's payment
// pages.
//
// Background (checked against Stripe in test mode, November 2026): a card
// saved through Stripe Checkout in setup mode (the automatic payments and
// "save a card" flows) was marked allow_redisplay=always. A Stripe payment
// page created with that customer then offers the card to whoever opens the
// page and charges it in one click. New saves are kept "limited" by the app
// (SAVED_CARD_REDISPLAY in api/_lib/stripe.js); this script does the same
// for the cards saved before that change. A "limited" card still charges
// off-session exactly as before (late-cancel and no-show fees, automatic
// payments, one-tap invoice payment), so nothing a client or a business
// sees changes.
//
// DRY RUN BY DEFAULT. It writes NOTHING to Stripe unless --apply is passed.
// It never writes to the database, never charges, never detaches a card.
// The only write it can make is, per card:
//     POST /v1/payment_methods/:id   allow_redisplay=limited
// Safe to run again: a card that is already "limited" is skipped.
//
// Which cards, per business with Stripe connected:
//   1. every card a client row or an automatic payment agreement holds;
//   2. every card saved through a Stripe setup page on the business's
//      account, read from Stripe itself. This is what finds cards the
//      database no longer knows (a deleted or merged client, a replaced
//      card). On an account the business connected with its own key, only
//      setups Ivy made (marked purpose=save_card) or whose customer Ivy
//      knows are touched, so a card another tool saved is left alone.
//
// Run (needs the same env as the app: DATABASE_URL, STRIPE_SECRET_KEY,
// SECRETS_KEY). It touches live Stripe data when those are the live values:
// do not pass --apply without the owner's say-so.
//
//   node scripts/limit-saved-card-redisplay.mjs                    # dry run, everything
//   node scripts/limit-saved-card-redisplay.mjs --workspace <id>   # dry run, one business
//   node scripts/limit-saved-card-redisplay.mjs --apply            # make the change
import { pathToFileURL } from 'node:url';
import { sql } from '../api/_lib/db.js';
import { loadStripeCreds } from '../api/_lib/stripeCreds.js';
import { stripeFetch, SAVED_CARD_REDISPLAY } from '../api/_lib/stripe.js';

const MAX_PAGES = 500; // 50,000 setups per account; far past any real one

// Every card on this business's account that should be "limited" and is
// not. Reads only. Returns { cards: [{ id, customer, was, source }], errors }.
export async function findCardsToLimit({ workspaceId, creds }) {
  const { secretKey, stripeAccount } = creds;
  const errors = [];
  const found = new Map();
  const consider = (pm, source) => {
    if (!pm || typeof pm !== 'object' || !pm.id) return;
    if (pm.type && pm.type !== 'card') return;
    // A detached card belongs to no customer: no page can offer it, and
    // Stripe refuses to update it.
    if (!pm.customer) return;
    if (pm.allow_redisplay === SAVED_CARD_REDISPLAY) return;
    if (!found.has(pm.id)) {
      found.set(pm.id, {
        id: pm.id,
        customer: typeof pm.customer === 'string' ? pm.customer : pm.customer?.id || null,
        was: pm.allow_redisplay || 'not set',
        source,
      });
    }
  };

  // 1. What the database holds for this business.
  const known = await sql`
    SELECT payment_method_id AS pm, stripe_customer_id AS cus FROM clients
     WHERE workspace_id = ${workspaceId} AND (payment_method_id IS NOT NULL OR stripe_customer_id IS NOT NULL)
    UNION
    SELECT payment_method_id AS pm, stripe_customer_id AS cus FROM autopay_agreements
     WHERE workspace_id = ${workspaceId} AND (payment_method_id IS NOT NULL OR stripe_customer_id IS NOT NULL)
  `;
  const knownPms = new Set(known.rows.map((r) => r.pm).filter(Boolean));
  const knownCustomers = new Set(known.rows.map((r) => r.cus).filter(Boolean));
  for (const pmId of knownPms) {
    try {
      consider(await stripeFetch(`/payment_methods/${encodeURIComponent(pmId)}`, { secretKey, stripeAccount }), 'client record');
    } catch (err) {
      // A card removed at Stripe since: nothing left to limit.
      if (err.status !== 404) errors.push(`read ${pmId}: ${err.message}`);
    }
  }

  // 2. Every finished card setup on the account, from Stripe.
  let startingAfter = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ limit: '100', 'expand[0]': 'data.payment_method' });
    if (startingAfter) qs.set('starting_after', startingAfter);
    let list;
    try {
      list = await stripeFetch(`/setup_intents?${qs.toString()}`, { secretKey, stripeAccount });
    } catch (err) {
      errors.push(`list card setups: ${err.message}`);
      break;
    }
    const data = Array.isArray(list?.data) ? list.data : [];
    for (const si of data) {
      if (si.status !== 'succeeded') continue;
      const pm = si.payment_method;
      const customer = typeof si.customer === 'string' ? si.customer : si.customer?.id || null;
      // With the business's own key the account may hold setups from other
      // tools: only Ivy's own, or ones on a customer Ivy knows.
      const ours = !!stripeAccount || si.metadata?.purpose === 'save_card'
        || (customer && knownCustomers.has(customer)) || (pm?.id && knownPms.has(pm.id));
      if (ours) consider(pm, 'card setup page');
    }
    if (!list?.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1].id;
  }
  return { cards: [...found.values()], errors };
}

// Dry run unless apply is true. Returns totals; `log` receives the lines.
export async function runBackfill({ apply = false, workspaceId = null, log = console.log } = {}) {
  const { rows } = await sql`
    SELECT workspace_id FROM finance_settings
     WHERE (stripe_connect_user_id IS NOT NULL OR stripe_secret_encrypted IS NOT NULL)
       AND (${workspaceId}::uuid IS NULL OR workspace_id = ${workspaceId}::uuid)
     ORDER BY workspace_id
  `;
  const totals = { businesses: rows.length, found: 0, limited: 0, failed: 0, skipped: 0, errors: 0 };
  // Two businesses can share one Stripe account: change each card once.
  const done = new Set();
  log(apply
    ? 'APPLY: saved cards found below are set to allow_redisplay=limited in Stripe.'
    : 'DRY RUN: nothing is changed. Pass --apply to make the change.');
  for (const { workspace_id: wid } of rows) {
    let creds;
    try {
      creds = await loadStripeCreds(wid);
    } catch (err) {
      totals.skipped += 1;
      log(`business ${wid}: skipped (${err.code || err.message})`);
      continue;
    }
    const { cards, errors } = await findCardsToLimit({ workspaceId: wid, creds });
    const fresh = cards.filter((c) => !done.has(c.id));
    totals.errors += errors.length;
    for (const e of errors) log(`business ${wid}: could not ${e}`);
    log(`business ${wid}${creds.stripeAccount ? ` (${creds.stripeAccount})` : ''}: ${fresh.length} card${fresh.length === 1 ? '' : 's'} to limit`);
    for (const c of fresh) {
      done.add(c.id);
      totals.found += 1;
      if (!apply) {
        log(`  would limit ${c.id} on ${c.customer} (now "${c.was}", from ${c.source})`);
        continue;
      }
      try {
        await stripeFetch(`/payment_methods/${encodeURIComponent(c.id)}`, {
          method: 'POST', secretKey: creds.secretKey, stripeAccount: creds.stripeAccount,
          body: { allow_redisplay: SAVED_CARD_REDISPLAY },
        });
        totals.limited += 1;
        log(`  limited ${c.id} on ${c.customer} (was "${c.was}")`);
      } catch (err) {
        totals.failed += 1;
        log(`  FAILED ${c.id} on ${c.customer}: ${err.message}`);
      }
    }
  }
  log(apply
    ? `Done. ${totals.limited} of ${totals.found} cards limited, ${totals.failed} failed, across ${totals.businesses} businesses (${totals.skipped} skipped, ${totals.errors} read errors).`
    : `Dry run done. ${totals.found} cards would be limited across ${totals.businesses} businesses (${totals.skipped} skipped, ${totals.errors} read errors). Nothing was changed.`);
  return totals;
}

function parseArgs(argv) {
  const out = { apply: false, workspaceId: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--workspace') { out.workspaceId = argv[i + 1] || null; i += 1; } else throw new Error(`Unknown option: ${argv[i]}`);
  }
  if (out.workspaceId && !/^[0-9a-f-]{36}$/i.test(out.workspaceId)) throw new Error('--workspace needs a workspace id');
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const totals = await runBackfill(parseArgs(process.argv.slice(2)));
    process.exit(totals.failed > 0 || totals.errors > 0 ? 1 : 0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
