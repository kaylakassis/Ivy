// One-off: take every saved card off Stripe's payment pages.
//
// Why. A card saved through Checkout in setup mode (automatic payments, the
// portal's "save a card", the booking page's card on file) is marked
// allow_redisplay=always by Stripe. A payment page offers such a card back,
// "Pay with .... 4242", one click, to whoever opened a checkout that has the
// customer attached. Ivy never needs that: saved cards are charged from our
// own buttons, off-session, which works the same on a "limited" card (checked
// in test mode). New cards are limited as they are saved; this script does
// the cards saved before that.
//
// What it does. For every business with Stripe connected, for every Stripe
// customer on one of its client rows, it lists the customer's cards and turns
// any "always" card to "limited". Nothing else on the card, the customer or
// the client changes. No card is removed and no one is charged. Running it
// twice is harmless: the second run finds nothing to do.
//
// DRY RUN BY DEFAULT. Without --apply it only reads and reports.
//
//   node scripts/hide-saved-cards-from-checkout.mjs                 # report only
//   node scripts/hide-saved-cards-from-checkout.mjs --workspace <id> # one business, report only
//   node scripts/hide-saved-cards-from-checkout.mjs --apply          # make the change
//   node scripts/hide-saved-cards-from-checkout.mjs --verbose        # list each card (brand + last 4)
//
// Needs the production environment (DATABASE_URL, the Stripe platform key,
// SECRETS_KEY), the same variables the app runs with.
import { sql } from '../api/_lib/db.js';
import { loadStripeCreds } from '../api/_lib/stripeCreds.js';
import { hideSavedCardsForWorkspace } from '../api/_lib/savedCards.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const verbose = args.includes('--verbose');
const wsAt = args.indexOf('--workspace');
const onlyWorkspace = wsAt >= 0 ? args[wsAt + 1] : null;
if (wsAt >= 0 && !/^[0-9a-f-]{36}$/i.test(String(onlyWorkspace || ''))) {
  console.error('--workspace needs a workspace id');
  process.exit(2);
}

async function main() {
  console.log(apply
    ? 'APPLY: saved cards that payment pages would offer are being turned to "limited".'
    : 'DRY RUN: nothing is changed. Add --apply to make the change.');
  const { rows } = onlyWorkspace
    ? await sql`
        SELECT DISTINCT workspace_id FROM clients
         WHERE workspace_id = ${onlyWorkspace} AND stripe_customer_id IS NOT NULL`
    : await sql`
        SELECT DISTINCT workspace_id FROM clients
         WHERE stripe_customer_id IS NOT NULL
         ORDER BY workspace_id`;
  const total = { businesses: 0, skipped: 0, customers: 0, cards: 0, alreadyHidden: 0, toHide: 0, hidden: 0, failed: 0 };
  for (const { workspace_id: workspaceId } of rows) {
    let creds;
    try {
      creds = await loadStripeCreds(workspaceId);
    } catch (err) {
      // Stripe disconnected since: its customers cannot be reached, and no
      // checkout can be made for them either.
      total.skipped += 1;
      if (verbose) console.log(`  ${workspaceId}: skipped (${err.code || err.message})`);
      continue;
    }
    const r = await hideSavedCardsForWorkspace({
      workspaceId, creds, apply,
      onCard: verbose ? (c) => console.log(`    ${workspaceId} ${c.customerId} ${c.brand || 'card'} ending ${c.last4 || '????'}`) : null,
    });
    total.businesses += 1;
    for (const k of ['customers', 'cards', 'alreadyHidden', 'toHide', 'hidden', 'failed']) total[k] += r[k];
    if (r.toHide || r.failed) {
      console.log(`  ${workspaceId}: ${r.cards} cards on ${r.customers} customers, ${r.toHide} to change`
        + (apply ? `, ${r.hidden} changed` : '') + (r.failed ? `, ${r.failed} FAILED` : ''));
      for (const e of r.errors) console.log(`    ! ${e}`);
    }
  }
  console.log('');
  console.log(`Businesses looked at: ${total.businesses} (skipped, Stripe not connected: ${total.skipped})`);
  console.log(`Customers: ${total.customers}   Cards: ${total.cards}   Already off payment pages: ${total.alreadyHidden}`);
  console.log(apply
    ? `Changed to "limited": ${total.hidden} of ${total.toHide}   Failed: ${total.failed}`
    : `Would change to "limited": ${total.toHide}   Could not read: ${total.failed}`);
  process.exit(total.failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
