// Load generator. Runs from the repo root so it can sign sessions with the
// app's own code:
//   node <load>/gen.mjs profile              one request per endpoint, typical + large business
//   node <load>/gen.mjs ramp 20,50,100 20    mixed traffic at each concurrency for N seconds
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.JWT_SECRET ||= 'test_secret_for_local_dev_only_at_least_32_chars';
const { signSession } = await import(pathToFileURL(path.join(process.cwd(), 'api/_lib/auth.js')).href);
const PORTS = (process.env.PORTS || '5500').split(',').map(Number);
const OUT = path.dirname(new URL(import.meta.url).pathname);
const uuid = (s) => { const h = crypto.createHash('md5').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const cookieFor = (userId) => `ivy_session=${signSession(userId)}`;
const nClients = (n) => (n % 50 === 0 ? 2000 : 40 + (n % 7) * 30);
const iso = (d) => d.toISOString().slice(0, 10);
const day = (off) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + off); return iso(d); };
let rr = 0;
const base = () => `http://127.0.0.1:${PORTS[rr++ % PORTS.length]}`;
const cookies = new Map();
const owner = (n) => { const k = 'o' + n; if (!cookies.has(k)) cookies.set(k, cookieFor(uuid('owner' + n))); return cookies.get(k); };
const client = (n, k) => { const key = `c${n}-${k}`; if (!cookies.has(key)) cookies.set(key, cookieFor(uuid(`cu${n}-${k}`))); return cookies.get(key); };

const lat = new Map();   // tag -> { ms: [], err, s4 }
async function call(tag, method, url, { cookie, body, ip } = {}) {
  const t0 = performance.now();
  let status = 0;
  try {
    const r = await fetch(base() + '/api' + url, {
      method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'x-forwarded-for': ip || `10.${rr % 250}.${(rr >> 8) % 250}.7`, 'x-load-tag': tag },
      body: body ? JSON.stringify(body) : undefined,
    });
    status = r.status; await r.arrayBuffer();
  } catch { status = 599; }
  const ms = performance.now() - t0;
  const s = lat.get(tag) || { ms: [], err: 0, s4: 0, codes: {} };
  s.ms.push(ms); if (status >= 500) s.err++; else if (status >= 400) { s.s4++; s.codes[status] = (s.codes[status] || 0) + 1; }
  lat.set(tag, s);
  return status;
}

// ---- what each kind of person does ------------------------------------
const ownerReads = (n) => {
  const c = owner(n); const k = 1 + Math.floor(Math.random() * nClients(n)); const tk = 3 * (1 + Math.floor(Math.random() * Math.floor(nClients(n) / 3)));
  return [
    ['owner: who am I', 'GET', '/auth/me'],
    ['owner: dashboard', 'GET', '/dashboard'],
    ['owner: tasks', 'GET', '/tasks'],
    ['owner: goals', 'GET', '/goals'],
    ['owner: calendar week', 'GET', `/calendar?from=${day(-1)}&to=${day(6)}`],
    ['owner: calendar month', 'GET', `/calendar?from=${day(-15)}&to=${day(20)}`],
    ['owner: calendar setup', 'GET', '/calendar?only=setup'],
    ['owner: clients first page', 'GET', '/clients?cursor=&limit=50&summary=1&window=30&leadWindow=30'],
    ['owner: clients search', 'GET', '/clients?cursor=&limit=50&q=riv'],
    ['owner: clients all (pickers)', 'GET', '/clients'],
    ['owner: client health', 'GET', '/clients/metrics?all=1'],
    ['owner: duplicate check', 'GET', '/clients/duplicates?count=1'],
    ['owner: one client', 'GET', `/clients/${uuid(`cl${n}-${k}`)}`],
    ['owner: finance summary', 'GET', '/finance'],
    ['owner: invoices first page', 'GET', '/invoices?cursor=&limit=50'],
    ['owner: one invoice', 'GET', `/invoices/${uuid(`inv${n}-${1 + (k % 60)}`)}`],
    ['owner: message list', 'GET', '/messages'],
    ['owner: one conversation', 'GET', `/messages/${uuid(`th${n}-${tk}`)}`],
    ['owner: notifications', 'GET', '/me/notification-feed'],
    ['owner: search', 'GET', '/search?q=riv'],
    ['owner: reviews', 'GET', '/reviews'],
    ['owner: expenses', 'GET', '/expenses'],
    ['owner: Ivy chats', 'GET', '/ivy'],
  ].map(([tag, m, u]) => [tag, m, u, { cookie: c }]);
};
const ownerWrites = (n) => {
  const c = owner(n); const s = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const k = 1 + Math.floor(Math.random() * nClients(n)); const tk = 3 * (1 + Math.floor(Math.random() * Math.floor(nClients(n) / 3)));
  return [
    ['owner: add client', 'POST', '/clients', { cookie: c, body: { name: 'Load New ' + s, email: `new-${s}@example.com`, stage: 'active', sendInvite: false } }],
    ['owner: add booking', 'POST', '/calendar/bookings', { cookie: c, body: { clientId: uuid(`cl${n}-${k}`), clientName: 'Load Client', serviceId: uuid(`svc${n}-1`), date: day(40 + Math.floor(Math.random() * 60)), startMin: 540 + 30 * Math.floor(Math.random() * 14), endMin: 600 + 30 * 14, skipConflictCheck: true } }],
    ['owner: new invoice', 'POST', '/invoices', { cookie: c, body: { clientId: uuid(`cl${n}-${k}`), items: [{ id: 'li1', description: 'Session', quantity: 1, rate: 85 }], discount: 0 } }],
    ['owner: send message', 'POST', `/messages/${uuid(`th${n}-${tk}`)}`, { cookie: c, body: { text: 'Thanks, see you then.', attachments: [] } }],
  ];
};
const clientReads = (n) => {
  const k = 1 + Math.floor(Math.random() * 5); const c = client(n, k);
  return [
    ['client: who am I', 'GET', '/auth/me'], ['client: home', 'GET', '/me'], ['client: bookings', 'GET', '/me/bookings'], ['client: invoices', 'GET', '/me/invoices'],
    ['client: messages', 'GET', '/me/threads'], ['client: notifications', 'GET', '/me/notification-feed'], ['client: packages', 'GET', '/me/packages?include=recent'],
    ['client: documents', 'GET', '/me/documents'],
  ].map(([tag, m, u]) => [tag, m, u, { cookie: c }]);
};
const publicReads = (n) => [['visitor: booking page', 'GET', `/calendar/public/load-biz-${n}`, {}]];
const publicBook = (n) => {
  const s = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const d = new Date(); d.setUTCDate(d.getUTCDate() + 3 + Math.floor(Math.random() * 20)); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  const start = 540 + 30 * Math.floor(Math.random() * 12);
  return [['visitor: book a time', 'POST', `/calendar/public/load-biz-${n}`, { body: { serviceId: uuid(`svc${n}-4`), date: iso(d), startMin: start, endMin: start + 45, clientName: 'Visitor ' + s, clientEmail: `visitor-${s}@example.com`, clientPhone: null, addOnIds: [], customFieldValues: {}, smsConsent: false, joinWaitlist: false } }]];
};

const pct = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const fmt = (x) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10);
async function serverStats(reset) {
  const all = await Promise.all(PORTS.map((p) => fetch(`http://127.0.0.1:${p}/__stats${reset ? '?reset=1' : ''}`).then((r) => r.json())));
  const routes = {}; const queries = new Map(); const errors = {}; let pool = { total: 0, idle: 0, waiting: 0 }; const outbound = { email: 0, sms: 0, other: 0 }; let mem = 0;
  for (const s of all) {
    for (const [k, v] of Object.entries(s.routes)) { const r = (routes[k] ||= { n: 0, err: 0, s4: 0, ms: [], db: [], q: [] }); r.n += v.n; r.err += v.err; r.s4 += v.s4; r.ms.push(...v.ms); r.db.push(...v.db); r.q.push(...v.q); }
    for (const q of s.queries) { const e = queries.get(q.text) || { n: 0, total: 0, max: 0 }; e.n += q.n; e.total += q.total; e.max = Math.max(e.max, q.max); queries.set(q.text, e); }
    Object.assign(errors, s.errors); if (s.pool) { pool.total += s.pool.total; pool.idle += s.pool.idle; pool.waiting += s.pool.waiting; }
    for (const k of Object.keys(outbound)) outbound[k] += s.outbound?.[k] || 0; mem += s.mem;
  }
  return { routes, queries, errors, pool, outbound, mem };
}
function routeTable(routes) {
  const rows = Object.entries(routes).map(([k, r]) => ({ k, n: r.n, err: r.err, s4: r.s4, p50: pct(r.ms, 50), p95: pct(r.ms, 95), p99: pct(r.ms, 99), db: pct(r.db, 50), db95: pct(r.db, 95), q: pct(r.q, 50), qmax: Math.max(0, ...r.q) }));
  rows.sort((a, b) => b.p95 - a.p95);
  return rows;
}
const show = (rows) => { console.log('  ' + 'request'.padEnd(46) + 'count'.padStart(7) + 'p50'.padStart(8) + 'p95'.padStart(8) + 'p99'.padStart(8) + 'db p50'.padStart(8) + 'db p95'.padStart(8) + 'queries'.padStart(9) + ' errors'); for (const r of rows) console.log('  ' + r.k.replace(/^(GET|POST|PATCH|DELETE) \S+ #/, '').slice(0, 45).padEnd(46) + String(r.n).padStart(7) + String(fmt(r.p50)).padStart(8) + String(fmt(r.p95)).padStart(8) + String(fmt(r.p99)).padStart(8) + String(fmt(r.db)).padStart(8) + String(fmt(r.db95)).padStart(8) + String(`${r.q}${r.qmax > r.q ? '-' + r.qmax : ''}`).padStart(9) + (r.err ? `  ${r.err} failed` : '') + (r.s4 ? `  ${r.s4} refused` : '')); };

const mode = process.argv[2] || 'profile';
if (mode === 'profile') {
  // One of everything, alone on the server: a typical business and a large one.
  for (const [label, n] of [['typical business (about 130 clients)', 17], ['large business (2,000 clients)', 50]]) {
    await serverStats(true);
    for (let rep = 0; rep < 3; rep++) {
      for (const [tag, m, u, o] of [...ownerReads(n), ...clientReads(n), ...publicReads(n), ...ownerWrites(n), ...publicBook(n)]) await call(tag, m, u, o);
    }
    const s = await serverStats(false);
    console.log(`\n=== ${label}: each request on its own (times in ms, server side)`);
    show(routeTable(s.routes));
    if (Object.keys(s.errors).length) console.log('  errors:', JSON.stringify(s.errors).slice(0, 600));
    fs.writeFileSync(`${OUT}/profile-${n}.json`, JSON.stringify({ routes: routeTable(s.routes), queries: [...s.queries].map(([text, v]) => ({ text, ...v, avg: v.total / v.n })).sort((a, b) => b.avg - a.avg).slice(0, 60) }, null, 1));
    console.log('  slowest queries:'); for (const q of [...s.queries].map(([text, v]) => ({ text, ...v, avg: v.total / v.n })).sort((a, b) => b.avg - a.avg).slice(0, 8)) console.log(`   ${fmt(q.avg)}ms avg, ${fmt(q.max)} max, x${q.n}: ${q.text.slice(0, 150)}`);
  }
} else if (mode === 'ramp') {
  const levels = (process.argv[3] || '20,50,100').split(',').map(Number); const secs = Number(process.argv[4] || 20);
  // Traffic mix by who is acting: 65% owners, 12% clients, 23% visitors. One in ten owner actions is a change.
  const pickN = () => 1 + Math.floor(Math.random() * 2000);
  const next = () => { const r = Math.random(); const n = pickN();
    if (r < 0.585) { const a = ownerReads(n); return a[Math.floor(Math.random() * a.length)]; }
    if (r < 0.65) { const a = ownerWrites(n); return a[Math.floor(Math.random() * a.length)]; }
    if (r < 0.77) { const a = clientReads(n); return a[Math.floor(Math.random() * a.length)]; }
    if (r < 0.97) return publicReads(n)[0];
    return publicBook(n)[0]; };
  const summary = [];
  for (const conc of levels) {
    lat.clear(); await serverStats(true);
    const until = Date.now() + secs * 1000; let done = 0;
    const worker = async () => { while (Date.now() < until) { const [tag, m, u, o] = next(); await call(tag, m, u, o); done++; } };
    const t0 = Date.now();
    await Promise.all(Array.from({ length: conc }, worker));
    const took = (Date.now() - t0) / 1000;
    const s = await serverStats(false);
    const all = [...lat.values()].flatMap((x) => x.ms); const errs = [...lat.values()].reduce((a, x) => a + x.err, 0); const s4 = [...lat.values()].reduce((a, x) => a + x.s4, 0);
    const srv = Object.values(s.routes); const srvMs = srv.flatMap((r) => r.ms); const srvDb = srv.flatMap((r) => r.db);
    console.log(`\n=== ${conc} people at once for ${secs}s: ${done} requests, ${fmt(done / took)}/s | as the person sees it p50 ${fmt(pct(all, 50))} p95 ${fmt(pct(all, 95))} p99 ${fmt(pct(all, 99))} ms | database part p50 ${fmt(pct(srvDb, 50))} p95 ${fmt(pct(srvDb, 95))} | failed ${errs}, refused ${s4} | db connections ${JSON.stringify(s.pool)} | emails ${s.outbound.email} | server memory ${s.mem} MB`);
    show(routeTable(s.routes).slice(0, 12));
    const codes = {}; for (const [tag, v] of lat) for (const [c, k] of Object.entries(v.codes)) codes[`${tag} ${c}`] = k;
    if (Object.keys(codes).length) console.log('  refused:', JSON.stringify(codes).slice(0, 500));
    if (Object.keys(s.errors).length) console.log('  errors:', JSON.stringify(s.errors).slice(0, 700));
    summary.push({ conc, rps: done / took, p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), dbp50: pct(srvDb, 50), dbp95: pct(srvDb, 95), errs, s4, routes: routeTable(s.routes), queries: [...s.queries].map(([text, v]) => ({ text, ...v, avg: v.total / v.n })).sort((a, b) => b.total - a.total).slice(0, 40) });
  }
  fs.writeFileSync(`${OUT}/ramp-${process.env.RUN || 'run'}.json`, JSON.stringify(summary, null, 1));
}
process.exit(0);
