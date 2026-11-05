// Admin email blasts reach real, live customers only: never a deleted
// account, the operator's super-admin login, or a flagged test account.
// userAllowsEmail refuses every type for a deleted account.
// Run: node --import ./tests/bootstrap.mjs ./tests/email-blast-recipients.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { loadSegment } from '../api/admin/email-blast.js';
import { userAllowsEmail } from '../api/_lib/notificationPrefs.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();

async function person(tag, { type = 'regular', tester = false, deleted = false, verified = true, owner = null } = {}) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at, user_type, is_tester, deleted_at)
    VALUES (${`blast-${tag}-${S}@example.com`}, 'x', ${tag}, ${verified ? new Date() : null}, ${type}, ${tester}, ${deleted ? new Date() : null}) RETURNING id`).rows[0].id;
  if (owner) {
    await sql.query(`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, trial_ends_at)
      VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', NOW() + INTERVAL '10 days')`, [u, tag, owner]);
  }
  return u;
}

async function main() {
  await ensureSchemaApplied();
  const real = await person('real', { owner: 'active' });
  const trial = await person('trial', { owner: 'trialing' });
  const spons = await person('spons', { type: 'sponsored' });
  const deletedActive = await person('deleted', { owner: 'active', deleted: true });
  const deletedSpons = await person('delspons', { type: 'sponsored', deleted: true });
  const admin = await person('admin', { type: 'super_admin', owner: 'active' });
  const tester = await person('tester', { tester: true, owner: 'active' });
  const unverified = await person('unver', { verified: false, owner: 'active' });

  // Service blasts (purpose 'service') go to the whole segment; the
  // default (marketing) is checked in [4].
  const ids = async (seg) => new Set((await loadSegment(seg, { marketingOnly: false })).map((r) => r.id));
  const all = await ids('all');
  const act = await ids('business-active');
  const tri = await ids('business-trial');
  const sp = await ids('sponsored');

  console.log('\n[1] real customers are included');
  assert(all.has(real) && act.has(real), 'active owner in all + business-active');
  assert(tri.has(trial), 'trialing owner in business-trial');
  assert(sp.has(spons), 'sponsored user in sponsored');

  console.log('\n[2] deleted / super-admin / tester / unverified are excluded from every segment');
  for (const [seg, set] of [['all', all], ['business-active', act], ['business-trial', tri], ['sponsored', sp]]) {
    assert(![deletedActive, deletedSpons, admin, tester, unverified].some((id) => set.has(id)), `${seg}: none of the excluded accounts`);
  }

  console.log('\n[3] userAllowsEmail refuses a deleted account, critical or not');
  assert(await userAllowsEmail(real, 'marketing') === true, 'live user, marketing: allowed');
  assert(await userAllowsEmail(deletedActive, 'marketing') === false, 'deleted user, marketing: refused');
  assert(await userAllowsEmail(deletedActive, 'security') === false, 'deleted user, critical type: refused');
  assert(await userAllowsEmail(deletedActive, undefined) === false, 'deleted user, no type: refused');

  console.log('\n[4] marketing blasts (the default) reach only people who opted in');
  const optedIn = await person('optin', { owner: 'active' });
  await sql`UPDATE users SET marketing_consent_at = NOW(), marketing_consent_source = 'signup' WHERE id = ${optedIn}`;
  const optedInMuted = await person('optinmuted', { owner: 'active' });
  await sql`UPDATE users SET marketing_consent_at = NOW(), notification_prefs = '{"email_marketing": false}'::jsonb WHERE id = ${optedInMuted}`;
  const mAll = new Set((await loadSegment('all')).map((r) => r.id));
  const mAct = new Set((await loadSegment('business-active', { marketingOnly: true })).map((r) => r.id));
  const mList = new Set((await loadSegment('marketing-opted-in', { marketingOnly: false })).map((r) => r.id));
  assert(mAll.has(optedIn) && mAct.has(optedIn) && mList.has(optedIn), 'opted-in owner gets marketing in every segment');
  assert(![real, trial, spons].some((id) => mAll.has(id) || mAct.has(id) || mList.has(id)), 'no consent: never in a marketing blast');
  assert(!mAll.has(optedInMuted) && !mList.has(optedInMuted), 'opted in but later unsubscribed: excluded');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e); process.exit(1); });
