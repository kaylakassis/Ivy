// A gift card refund gives back at most what is left on the card (the
// money already spent stays spent) and the card is void once nothing is
// left. While the processor refund is in flight the amount being refunded
// cannot also be spent, and a failed processor refund puts it back.
//
//   [1] cap: a card with $40 left of $100 refunds at most $40, then is void
//   [2] in flight: the amount being refunded cannot be spent at the same
//       moment; what is not being refunded still can
//   [3] the processor refuses: nothing is refunded and the balance is whole
//   [4] the owner screen says how much can be refunded, in plain words
//   [5] a hold left behind by a refund that never finished (a crash between
//       the hold and the processor call) expires after 15 minutes: the next
//       read of the card's balance asks the processor first and puts it
//       back only when no refund happened; a fresh hold stays
//   [6] the processor shows the refund DID happen: it is recorded (the hold
//       becomes the refund, the balance is not given back)
//   [7] the processor cannot be asked: the hold stays and the owner is told
//
// Run with: node --import ./tests/bootstrap.mjs ./tests/gift-card-refund-cap.test.mjs
import fs from 'node:fs';
process.env.STRIPE_SECRET_KEY = 'sk_test_gccap';
process.env.SECRETS_KEY ||= 'a'.repeat(64);
process.env.APP_URL ||= 'https://www.joinivy.ai';
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import { redeemAtomic, findActiveByCode, generateCode, normalizeCode, hashCode } from '../api/_lib/giftCards.js';
import giftCardRefund from '../api/gift-cards/refund.js';
import giftCardList from '../api/gift-cards/index.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const STAMP = Date.now();
const refunds = [];
let onRefund = null;
let refuse = false;
const lookups = [];
const processorRefunds = new Map();
const lookupDown = new Set();
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const listed = u.match(/api\.stripe\.com\/v1\/refunds\?payment_intent=([^&]+)/);
  if (listed && (init.method || 'GET') === 'GET') {
    const pi = decodeURIComponent(listed[1]);
    lookups.push(pi);
    if (lookupDown.has(pi)) return json({ error: { message: 'Stripe is unavailable' } }, 503);
    return json({ object: 'list', has_more: false, data: (processorRefunds.get(pi) || []) });
  }
  if (/api\.stripe\.com\/v1\/refunds/.test(u)) {
    const body = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    if (onRefund) await onRefund(body);
    if (refuse) return json({ error: { message: 'Insufficient funds in the connected account' } }, 400);
    refunds.push(body);
    return json({ id: `re_gc_${STAMP}_${refunds.length}`, amount: Number(body.amount), status: 'succeeded' });
  }
  return json({ id: 'x' });
};
function mkRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(o) { this.body = o; return this; },
    end(s) { this.body = s ?? this.body; return this; },
  };
}
const HOST = 'www.joinivy.ai';
const req = ({ method = 'POST', cookie, body = {} } = {}) => ({
  method, url: '/t', query: {}, body,
  headers: { 'content-type': 'application/json', origin: `https://${HOST}`, host: HOST, 'x-forwarded-for': '198.18.92.4', ...(cookie ? { cookie } : {}) },
});
async function call(handler, r) { const res = mkRes(); await handler(r, res); return res; }
const cardRow = (id) => sql`SELECT * FROM gift_cards WHERE id = ${id}`.then((r) => r.rows[0]);

let uid, wid;
async function mkCard(label, original, balance) {
  return (await sql`INSERT INTO gift_cards (workspace_id, code_hash, code_last4, original_amount_cents, balance_cents, status, stripe_payment_intent, sender_email, sender_name)
    VALUES (${wid}, ${`gccap-${label}-${STAMP}`}, ${label.slice(0, 4).toUpperCase()}, ${original}, ${balance}, 'active', ${`pi_gccap_${label}_${STAMP}`}, ${`buyer-${STAMP}@example.com`}, 'Pat Buyer')
    RETURNING *`).rows[0];
}

async function run() {
  await ensureSchemaApplied();
  uid = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, terms_version, terms_accepted_at)
    VALUES (${`gccap-${STAMP}@example.com`}, 'x', 'Owner', NOW(), '2026-05-05', NOW()) RETURNING id`).rows[0].id;
  wid = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${uid}, 'Cap Studio', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  await sql`INSERT INTO finance_settings (workspace_id, stripe_connect_user_id, stripe_onboarding_status) VALUES (${wid}, ${`acct_gccap_${STAMP}`}, 'complete')`;
  const cookie = `ivy_session=${signSession(uid)}`;

  console.log('\n[1] capped at what is left on the card');
  const a = await mkCard('alfa', 10000, 4000);
  let r = await call(giftCardList, req({ method: 'GET', cookie }));
  assert(r.body.cards.find((c) => c.id === a.id)?.refundableCents === 4000, 'list: $40 refundable');
  r = await call(giftCardRefund, req({ cookie, body: { id: a.id, amountCents: 10000 } }));
  assert(r.statusCode === 400 && /You can refund up to \$40\.00, what's left on the card\./.test(r.body.error) && refunds.length === 0,
    `asking for the $100 paid is refused in plain words (${r.body.error})`);
  r = await call(giftCardRefund, req({ cookie, body: { id: a.id } }));
  assert(r.statusCode === 200 && r.body.refund.amountCents === 4000 && refunds[0]?.amount === '4000', `"everything" means the $40 left (${JSON.stringify(r.body.refund)})`);
  let c = await cardRow(a.id);
  assert(c.status === 'voided' && Number(c.balance_cents) === 0 && Number(c.refunded_cents) === 4000 && Number(c.refund_hold_cents) === 0,
    `card void afterwards (${c.status} ${c.balance_cents} ${c.refunded_cents})`);
  assert(r.body.card?.status === 'voided' && r.body.card?.refundableCents === 0, 'payload: void, nothing more to refund');

  console.log('\n[2] the amount being refunded cannot be spent while the refund is in flight');
  const b = await mkCard('bravo', 10000, 10000);
  const spends = [];
  onRefund = async () => {
    spends.push(await redeemAtomic({ giftCardId: b.id, workspaceId: wid, amountCents: 5000, appliedToKind: 'booking', appliedToId: null, clientId: null }).then(() => 'spent').catch((e) => e.code || e.message));
    spends.push(await redeemAtomic({ giftCardId: b.id, workspaceId: wid, amountCents: 4000, appliedToKind: 'booking', appliedToId: null, clientId: null }).then(() => 'spent').catch((e) => e.code || e.message));
  };
  r = await call(giftCardRefund, req({ cookie, body: { id: b.id, amountCents: 6000 } }));
  onRefund = null;
  assert(r.statusCode === 200 && r.body.refund.amountCents === 6000, 'the $60 refund went through');
  assert(spends[0] === 'insufficient' && spends[1] === 'spent', `a $50 spend mid-refund is refused, $40 still spendable (${spends.join(', ')})`);
  c = await cardRow(b.id);
  assert(Number(c.balance_cents) === 0 && Number(c.refunded_cents) === 6000 && Number(c.refund_hold_cents) === 0,
    `$60 refunded + $40 spent = $100, nothing given twice (${c.balance_cents} / ${c.refunded_cents})`);

  console.log('\n[3] the processor refuses: the balance is whole again');
  const d = await mkCard('delta', 5000, 5000);
  refuse = true;
  r = await call(giftCardRefund, req({ cookie, body: { id: d.id, amountCents: 2000 } }));
  refuse = false;
  c = await cardRow(d.id);
  assert(r.statusCode === 400 && /Insufficient funds/.test(r.body.error || ''), `refused with the reason (${r.body.error})`);
  assert(Number(c.balance_cents) === 5000 && Number(c.refund_hold_cents) === 0 && Number(c.refunded_cents) === 0 && c.status === 'active',
    'balance back to $50, nothing refunded, still active');

  console.log('\n[4] owner screen copy');
  const src = fs.readFileSync(new URL('../src/features/finance/GiftCards.jsx', import.meta.url), 'utf8');
  assert(/You can refund up to \$\{fmtMoney\(refundLeftCents\)\}, what's left on the card\./.test(src), 'refund row says "You can refund up to $X, what\'s left on the card."');
  assert(/refundableCents/.test(src), 'the screen uses the server\'s refundable amount');

  console.log('\n[5] a stuck refund hold expires');
  const raw = generateCode();
  const stuck = (await sql`INSERT INTO gift_cards (workspace_id, code_hash, code_last4, original_amount_cents, balance_cents, refund_hold_cents, refund_hold_at, status, stripe_payment_intent)
    VALUES (${wid}, ${hashCode(normalizeCode(raw))}, 'STCK', 10000, 4000, 6000, NOW() - INTERVAL '20 minutes', 'active', ${`pi_gccap_stuck_${STAMP}`}) RETURNING id`).rows[0];
  const found = await findActiveByCode(wid, raw);
  c = await cardRow(stuck.id);
  assert(Number(found?.balance_cents) === 10000 && Number(c.balance_cents) === 10000 && Number(c.refund_hold_cents) === 0 && c.refund_hold_at == null,
    `the 20-minute-old hold is released on the next balance read (${found?.balance_cents} / ${c.balance_cents})`);
  const fresh = (await sql`INSERT INTO gift_cards (workspace_id, code_hash, code_last4, original_amount_cents, balance_cents, refund_hold_cents, refund_hold_at, status, stripe_payment_intent)
    VALUES (${wid}, ${`gccap-fresh-${STAMP}`}, 'FRSH', 10000, 4000, 6000, NOW() - INTERVAL '5 minutes', 'active', ${`pi_gccap_fresh_${STAMP}`}) RETURNING id`).rows[0];
  r = await call(giftCardList, req({ method: 'GET', cookie }));
  c = await cardRow(fresh.id);
  assert(Number(c.balance_cents) === 4000 && Number(c.refund_hold_cents) === 6000 && r.body.cards.find((x) => x.id === fresh.id)?.refundableCents === 4000,
    'a 5-minute-old hold (refund maybe still going through) stays');
  await sql`UPDATE gift_cards SET refund_hold_at = NOW() - INTERVAL '16 minutes' WHERE id = ${fresh.id}`;
  r = await call(giftCardList, req({ method: 'GET', cookie }));
  c = await cardRow(fresh.id);
  assert(Number(c.balance_cents) === 10000 && Number(c.refund_hold_cents) === 0 && r.body.cards.find((x) => x.id === fresh.id)?.refundableCents === 10000,
    'once older than 15 minutes, the owner list read releases it too');
  assert(lookups.includes(`pi_gccap_stuck_${STAMP}`) && lookups.includes(`pi_gccap_fresh_${STAMP}`) && lookups.filter((x) => x === `pi_gccap_fresh_${STAMP}`).length === 1,
    `the processor was asked before each release, and not for the fresh hold (${lookups.length} lookups)`);

  console.log('\n[6] the refund did happen: recorded, not given back');
  const done = (await sql`INSERT INTO gift_cards (workspace_id, code_hash, code_last4, original_amount_cents, balance_cents, refund_hold_cents, refund_hold_at, status, stripe_payment_intent, sender_email)
    VALUES (${wid}, ${`gccap-done-${STAMP}`}, 'DONE', 10000, 4000, 6000, NOW() - INTERVAL '30 minutes', 'active', ${`pi_gccap_done_${STAMP}`}, ${`buyer-${STAMP}@example.com`}) RETURNING id`).rows[0];
  processorRefunds.set(`pi_gccap_done_${STAMP}`, [{ id: 're_done', amount: 6000, status: 'succeeded' }]);
  await call(giftCardList, req({ method: 'GET', cookie }));
  c = await cardRow(done.id);
  assert(Number(c.balance_cents) === 4000 && Number(c.refund_hold_cents) === 0 && Number(c.refunded_cents) === 6000,
    `hold became the $60 refund; balance stays $40 (${c.balance_cents} / ${c.refunded_cents})`);

  console.log('\n[7] the processor cannot be asked: hold kept, owner told');
  const unk = (await sql`INSERT INTO gift_cards (workspace_id, code_hash, code_last4, original_amount_cents, balance_cents, refund_hold_cents, refund_hold_at, status, stripe_payment_intent)
    VALUES (${wid}, ${`gccap-unk-${STAMP}`}, 'UNKN', 10000, 4000, 6000, NOW() - INTERVAL '30 minutes', 'active', ${`pi_gccap_unk_${STAMP}`}) RETURNING id`).rows[0];
  lookupDown.add(`pi_gccap_unk_${STAMP}`);
  await call(giftCardList, req({ method: 'GET', cookie }));
  c = await cardRow(unk.id);
  const told = (await sql`SELECT body FROM notifications WHERE workspace_id = ${wid} AND body LIKE '%UNKN%'`).rows;
  assert(Number(c.balance_cents) === 4000 && Number(c.refund_hold_cents) === 6000, `hold kept (${c.balance_cents} / ${c.refund_hold_cents})`);
  assert(told.length === 1 && /\$60\.00/.test(told[0].body), `owner told (${told[0]?.body})`);
  const before = lookups.length;
  await call(giftCardList, req({ method: 'GET', cookie }));
  assert(lookups.length === before, 'not asked again on every read (checked again after 15 minutes)');
}

run()
  .catch((err) => { console.error('Fatal:', err.message, err.stack); fail++; })
  .finally(async () => {
    if (wid) {
      await sql`DELETE FROM notifications WHERE workspace_id = ${wid}`.catch(() => {});
      await sql`DELETE FROM gift_card_redemptions WHERE workspace_id = ${wid}`.catch(() => {});
      await sql`DELETE FROM gift_cards WHERE workspace_id = ${wid}`.catch(() => {});
      await sql`DELETE FROM finance_settings WHERE workspace_id = ${wid}`.catch(() => {});
      await sql`DELETE FROM workspaces WHERE id = ${wid}`.catch(() => {});
    }
    if (uid) await sql`DELETE FROM users WHERE id = ${uid}`.catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });
