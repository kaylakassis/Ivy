// Server paging for the owner's Finance invoice list and Clients list.
//
//   [1] Without ?cursor both endpoints answer exactly as before (iPhone
//       1.0.5 reads { invoices|clients, hasMore, nextOffset }).
//   [2] ?cursor pages walk the whole list once, newest first, in the same
//       order as the old list, with tab filters; a row added while paging
//       never makes another row repeat or vanish; a bad cursor is a 400;
//       nothing from another workspace ever appears.
//   [3] Clients: ?filter= and ?q= (name, email or tag; % and _ are taken
//       literally), `total` for the tab + search, and ?summary=1 counts and
//       analytics over the whole book, matching the rules the screen used
//       to apply to its loaded list.
//
// Run: node --import ./tests/bootstrap.mjs ./tests/list-paging.test.mjs
import { ensureSchemaApplied } from '../api/_lib/ensureSchema.js';
import { sql } from '../api/_lib/db.js';
import { signSession } from '../api/_lib/auth.js';
import invoicesApi from '../api/invoices/index.js';
import clientsApi from '../api/clients/index.js';

let pass = 0, fail = 0;
const assert = (c, l) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l); } };
const S = Date.now();
const DAY = 86400e3;

const mkRes = () => {
  const r = { statusCode: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.getHeader = (k) => r.headers[k.toLowerCase()];
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = (b) => { if (b !== undefined) { try { r.body = JSON.parse(b); } catch { r.body = b; } } return r; };
  return r;
};
let ipN = 0;
const get = async (handler, query, cookie) => {
  const res = mkRes();
  await handler({ method: 'GET', url: '/test', query, body: undefined,
    headers: { origin: 'http://localhost:3000', host: 'localhost:3000', cookie, 'x-forwarded-for': `198.51.100.${(ipN++ % 200) + 30}` } }, res);
  return res;
};

const users = [];
async function mkOwner(tag) {
  const u = (await sql`INSERT INTO users (email, password_hash, name, email_verified_at)
    VALUES (${`paging-${tag}-${S}@example.com`}, 'x', 'Owner', NOW()) RETURNING id`).rows[0].id;
  const w = (await sql`INSERT INTO workspaces (owner_id, name, subscription_status, subscription_period_end, onboarded_at)
    VALUES (${u}, 'Paging', 'active', NOW() + INTERVAL '30 days', NOW()) RETURNING id`).rows[0].id;
  users.push(u);
  return { ws: w, cookie: `ivy_session=${signSession(u)}` };
}
const mkInvoice = async (ws, n, { status = 'sent', daysAgo = 0, archived = false } = {}) => (await sql`
  INSERT INTO invoices (workspace_id, number, status, items, tax_rate, discount, issue_date, archived_at, client_name)
  VALUES (${ws}, ${`PG-${S}-${n}`}, ${status}, ${JSON.stringify([{ id: 'l', description: 'x', quantity: 1, rate: 10 }])}::jsonb, 0, 0,
          CURRENT_DATE - ${daysAgo}::int, ${archived ? new Date() : null}, 'Pat')
  RETURNING id`).rows[0].id;
const mkClient = async (ws, name, { stage = 'active', email = null, tags = [], joinedDaysAgo = 1, seenDaysAgo = null } = {}) => (await sql`
  INSERT INTO clients (workspace_id, name, email, stage, tags, joined_at, last_seen_at)
  VALUES (${ws}, ${name}, ${email}, ${stage}, ${tags}, NOW() - make_interval(days => ${joinedDaysAgo}),
          ${seenDaysAgo == null ? null : new Date(Date.now() - seenDaysAgo * DAY)})
  RETURNING id`).rows[0].id;

async function walk(handler, key, query, cookie, limit) {
  const seen = [];
  let cursor = '';
  for (let i = 0; i < 50; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await get(handler, { ...query, cursor, limit: String(limit) }, cookie);
    if (r.statusCode !== 200) return { error: r };
    seen.push(...r.body[key].map((x) => x.id));
    if (!r.body.nextCursor) return { ids: seen, first: r.body };
    cursor = r.body.nextCursor;
  }
  return { ids: seen };
}

async function run() {
  await ensureSchemaApplied();
  const A = await mkOwner('a');
  const B = await mkOwner('b');
  try {
    // Several on the same day, so the tie-break on created_at / id matters.
    const ids = [];
    for (let n = 0; n < 9; n++) {
      // eslint-disable-next-line no-await-in-loop
      ids.push(await mkInvoice(A.ws, n, { daysAgo: n % 3, status: n % 4 === 0 ? 'paid' : 'sent' }));
    }
    const archivedId = await mkInvoice(A.ws, 'arch', { status: 'paid', archived: true });
    const bId = await mkInvoice(B.ws, 'other');

    console.log('\n[1] no cursor: the old answer');
    let r = await get(invoicesApi, {}, A.cookie);
    assert(r.statusCode === 200 && JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['hasMore', 'invoices', 'nextOffset']),
      `invoices: same keys as before (${Object.keys(r.body)})`);
    const legacyOrder = r.body.invoices.map((i) => i.id);
    assert(legacyOrder.length === 9 && !legacyOrder.includes(archivedId) && !legacyOrder.includes(bId), 'invoices: archived and other workspace left out, as before');
    r = await get(invoicesApi, { limit: '4', offset: '4' }, A.cookie);
    assert(r.body.invoices.length === 4 && r.body.hasMore === true && r.body.nextOffset === 8, 'invoices: limit/offset paging unchanged');
    const c1 = await mkClient(A.ws, `Zed ${S}`, { email: `zed-${S}@example.com` });
    r = await get(clientsApi, {}, A.cookie);
    assert(r.statusCode === 200 && JSON.stringify(Object.keys(r.body).sort()) === JSON.stringify(['clients', 'hasMore', 'nextOffset'])
      && r.body.clients.some((c) => c.id === c1), 'clients: same keys as before');

    console.log('\n[2] cursor pages: invoices');
    let w = await walk(invoicesApi, 'invoices', {}, A.cookie, 4);
    assert(JSON.stringify(w.ids) === JSON.stringify(legacyOrder), 'every invoice once, in the old order, 4 at a time');
    r = await get(invoicesApi, { cursor: '', limit: '4' }, A.cookie);
    assert(r.body.invoices.length === 4 && r.body.hasMore === true && typeof r.body.nextCursor === 'string', 'first page: 4 + nextCursor');
    // A new invoice lands while the owner is on page 1: page 2 neither
    // repeats nor skips anything.
    const late = await mkInvoice(A.ws, 'late');
    const r2 = await get(invoicesApi, { cursor: r.body.nextCursor, limit: '100' }, A.cookie);
    const together = [...r.body.invoices.map((i) => i.id), ...r2.body.invoices.map((i) => i.id)];
    assert(JSON.stringify(together) === JSON.stringify(legacyOrder) && !together.includes(late), 'a row added mid-way does not shift the pages');
    w = await walk(invoicesApi, 'invoices', { status: 'paid' }, A.cookie, 2);
    assert(w.ids.length === 3 && !w.ids.includes(archivedId), `status tab pages (${w.ids.length})`);
    w = await walk(invoicesApi, 'invoices', { archived: 'only' }, A.cookie, 2);
    assert(JSON.stringify(w.ids) === JSON.stringify([archivedId]), 'archived tab');
    w = await walk(invoicesApi, 'invoices', {}, B.cookie, 2);
    assert(JSON.stringify(w.ids) === JSON.stringify([bId]), 'other workspace sees only its own');
    r = await get(invoicesApi, { cursor: r.body.nextCursor, limit: '50' }, B.cookie);
    assert(r.statusCode === 200 && r.body.invoices.every((i) => i.id === bId), "A's cursor in B's account shows nothing of A's");
    for (const bad of ['garbage', Buffer.from('["x","y","z"]').toString('base64url'), Buffer.from(`["2026-01-01","2026-01-01 00:00:00+00","not-a-uuid"]`).toString('base64url')]) {
      // eslint-disable-next-line no-await-in-loop
      r = await get(invoicesApi, { cursor: bad }, A.cookie);
      assert(r.statusCode === 400, `bad cursor is a 400 (${bad.slice(0, 12)})`);
    }

    console.log('\n[3] cursor pages: clients, filters, search, counts');
    const cl = {
      ann: await mkClient(A.ws, 'Ann 100% Real', { stage: 'active', email: 'ann@example.com', joinedDaysAgo: 5, seenDaysAgo: 0 }),
      bob: await mkClient(A.ws, 'Bob', { stage: 'lead', email: null, tags: ['VIP'], joinedDaysAgo: 3 }),
      cy: await mkClient(A.ws, 'Cy_Lead', { stage: 'lead', email: '  ', joinedDaysAgo: 40 }),
      dee: await mkClient(A.ws, 'Dee', { stage: 'paused', email: 'dee@example.com', joinedDaysAgo: 200, seenDaysAgo: 10 }),
      eve: await mkClient(A.ws, 'Eve', { stage: 'paused', email: 'eve@example.com', joinedDaysAgo: 300, seenDaysAgo: 90 }),
      fay: await mkClient(A.ws, 'Fay', { stage: 'active', email: 'fay@example.com', joinedDaysAgo: 100 }),
    };
    await mkClient(B.ws, 'Ann Other', { email: 'ann-b@example.com' });
    const legacy = (await get(clientsApi, {}, A.cookie)).body.clients;
    w = await walk(clientsApi, 'clients', {}, A.cookie, 2);
    assert(JSON.stringify(w.ids) === JSON.stringify(legacy.map((c) => c.id)), 'every client once, in the old order, 2 at a time');
    assert(w.first?.total === undefined, 'total only on the first page');
    r = await get(clientsApi, { cursor: '', limit: '2' }, A.cookie);
    assert(r.body.total === 7, `first page carries the total (${r.body.total})`);
    w = await walk(clientsApi, 'clients', { filter: 'leads' }, A.cookie, 1);
    assert(w.ids.length === 2 && w.ids.includes(cl.bob) && w.ids.includes(cl.cy), 'Leads tab');
    w = await walk(clientsApi, 'clients', { filter: 'noemail' }, A.cookie, 5);
    assert(w.ids.length === 2 && w.ids.includes(cl.bob) && w.ids.includes(cl.cy), 'Missing email tab (blank email counts as missing)');
    const search = async (q) => (await walk(clientsApi, 'clients', { q }, A.cookie, 50)).ids;
    assert(JSON.stringify(await search('ANN')) === JSON.stringify([cl.ann]), 'search by name, any case, this workspace only');
    assert(JSON.stringify(await search('fay@')) === JSON.stringify([cl.fay]), 'search by email');
    assert(JSON.stringify(await search('vip')) === JSON.stringify([cl.bob]), 'search by tag');
    assert(JSON.stringify(await search('100%')) === JSON.stringify([cl.ann]) && (await search('%')).length === 1, '% is literal');
    assert(JSON.stringify(await search('y_l')) === JSON.stringify([cl.cy]) && (await search('_')).length === 1, '_ is literal');
    r = await get(clientsApi, { cursor: '', q: 'e', filter: 'paused' }, A.cookie);
    assert(r.body.total === 2 && r.body.clients.length === 2, 'tab + search together, with total');

    r = await get(clientsApi, { summary: 'only', window: '30', leadWindow: '7' }, A.cookie);
    const s = r.body.summary;
    assert(r.statusCode === 200 && !('clients' in r.body), 'summary=only returns just the numbers');
    // The rules the screen used to run over its loaded list, run here over
    // the full old list.
    const now = Date.now();
    const act = legacy.filter((c) => c.stage === 'active');
    const lds = legacy.filter((c) => c.stage === 'lead');
    const pau = legacy.filter((c) => c.stage === 'paused');
    const winAgo = now - 30 * DAY;
    const recentA = act.filter((c) => new Date(c.joinedAt).getTime() >= winAgo).length;
    const recentL = lds.filter((c) => new Date(c.joinedAt).getTime() >= winAgo).length;
    const churn = pau.filter((c) => new Date(c.lastSeenAt || c.joinedAt).getTime() >= winAgo).length;
    const expect = {
      counts: { all: legacy.length, active: act.length, leads: lds.length, paused: pau.length, noemail: legacy.filter((c) => !(c.email || '').trim()).length },
      recentActives: recentA, recentLeads: recentL,
      conversionRate: recentA + recentL === 0 ? 0 : Math.round((recentA / (recentA + recentL)) * 100),
      churnCount: churn, churnRate: act.length + pau.length === 0 ? 0 : Math.round((churn / (act.length + pau.length)) * 100),
      leadsInWindow: lds.filter((c) => (now - new Date(c.joinedAt).getTime()) / DAY <= 7).length,
    };
    assert(JSON.stringify(s.counts) === JSON.stringify(expect.counts), `tab counts match the whole book (${JSON.stringify(s.counts)})`);
    const got = { recentActives: s.analytics.recentActives, recentLeads: s.analytics.recentLeads, conversionRate: s.analytics.conversionRate,
      churnCount: s.analytics.churnCount, churnRate: s.analytics.churnRate, leadsInWindow: s.analytics.leadsInWindow };
    const want = { recentActives: expect.recentActives, recentLeads: expect.recentLeads, conversionRate: expect.conversionRate,
      churnCount: expect.churnCount, churnRate: expect.churnRate, leadsInWindow: expect.leadsInWindow };
    assert(JSON.stringify(got) === JSON.stringify(want), `analytics match the old screen math (${JSON.stringify(got)})`);
    r = await get(clientsApi, { cursor: '', limit: '1', summary: '1' }, A.cookie);
    assert(r.body.clients.length === 1 && r.body.summary.counts.all === 7, 'summary=1 with a page: counts are for the whole book, not the page');
    r = await get(clientsApi, { cursor: 'nope' }, A.cookie);
    assert(r.statusCode === 400, 'bad client cursor is a 400');
    r = await get(clientsApi, { summary: 'only' }, B.cookie);
    assert(r.body.summary.counts.all === 1, "another workspace's counts are its own");
  } catch (e) {
    console.error('Fatal:', e);
    fail++;
  } finally {
    for (const u of users) {
      // eslint-disable-next-line no-await-in-loop
      await sql`DELETE FROM workspaces WHERE owner_id = ${u}`.catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await sql`DELETE FROM users WHERE id = ${u}`.catch(() => {});
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
run();
