// Win-back static-mode override. When WINBACK_STRIPE_COUPON_ID +
// WINBACK_PROMO_CODE are both set, ensureWinbackOffer uses them verbatim
// instead of minting per-workspace via Stripe. Lets the operator manage
// the offer in the Stripe dashboard without a redeploy.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/winback-static.test.mjs

import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { ensureWinbackOffer, WINBACK } from '../api/_lib/winback.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };

const EMAIL = `wb-static-${Date.now()}@example.com`;
let ownerId, workspaceId;

async function mkWorkspace() {
  const u = await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${EMAIL}, 'x', 'Static WB', NOW()) RETURNING id`;
  ownerId = u.rows[0].id;
  const w = await sql`INSERT INTO workspaces (owner_id, subscription_status, paywall_first_seen_at)
    VALUES (${ownerId}, 'incomplete', NOW() - INTERVAL '2 days') RETURNING id`;
  workspaceId = w.rows[0].id;
}

async function run() {
  try {
    await ensureSchemaApplied();
    await sql`DELETE FROM users WHERE email = ${EMAIL}`;
    await mkWorkspace();

    console.log('\n[1] static mode: env vars set → returns operator-configured code without Stripe minting');
    process.env.WINBACK_STRIPE_COUPON_ID = '6igOZBm1';
    process.env.WINBACK_PROMO_CODE = 'HEADSTART30';
    let offer = await ensureWinbackOffer({ secretKey: 'never-called-in-static-mode', workspaceId });
    assert(offer && offer.fresh === true, 'fresh offer minted');
    assert(offer.promoCode === 'HEADSTART30', `promoCode = HEADSTART30 (got "${offer?.promoCode}")`);
    assert(offer.couponId === '6igOZBm1', `couponId = 6igOZBm1 (got "${offer?.couponId}")`);
    assert(offer.percentOff === WINBACK.PERCENT_OFF, 'percentOff carries through from constants');
    assert(offer.durationMonths === WINBACK.DURATION_MONTHS, 'durationMonths carries through');

    console.log('\n[2] second call returns cached offer (one per workspace, ever)');
    const offer2 = await ensureWinbackOffer({ secretKey: 'x', workspaceId });
    assert(offer2 && offer2.fresh === false, 'second call is fresh=false (cached)');
    assert(offer2.promoCode === 'HEADSTART30', 'returns the SAME static code on cached path');

    console.log('\n[3] static mode REQUIRES BOTH env vars — one missing falls back');
    // Reset workspace so we mint again.
    await sql`UPDATE workspaces SET
        winback_offer_sent_at = NULL,
        winback_coupon_id = NULL,
        winback_promo_code = NULL,
        winback_expires_at = NULL
      WHERE id = ${workspaceId}`;
    delete process.env.WINBACK_STRIPE_COUPON_ID;
    process.env.WINBACK_PROMO_CODE = 'HEADSTART30';
    // With only one env var set, static mode is off and we'd try to mint.
    // The mint call needs a real Stripe key; we expect it to throw — that
    // proves we took the DYNAMIC branch, not the static one.
    let threw = false;
    try { await ensureWinbackOffer({ secretKey: 'sk_test_bogus', workspaceId }); }
    catch { threw = true; }
    assert(threw, 'falls back to dynamic mint when WINBACK_STRIPE_COUPON_ID is missing');
  } catch (err) {
    console.error('Fatal:', err.message, err.stack);
    fail++;
  } finally {
    await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => {});
    await sql`DELETE FROM users WHERE id = ${ownerId}`.catch(() => {});
    delete process.env.WINBACK_STRIPE_COUPON_ID;
    delete process.env.WINBACK_PROMO_CODE;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
