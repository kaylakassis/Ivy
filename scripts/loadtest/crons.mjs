// Run every scheduled job once against the load database and time it.
//   node <load>/crons.mjs [port]      (run from the repo root; the port's server must be up)
import fs from 'node:fs';
import path from 'node:path';
const PORT = Number(process.argv[2] || 5510);
const OUT = path.dirname(new URL(import.meta.url).pathname);
const v = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8'));
const only = process.argv[3] ? process.argv[3].split(',') : null;
const jobs = v.crons.map((c) => ({ path: c.path, schedule: c.schedule })).filter((j) => !only || only.some((o) => j.path.includes(o)));
const stats = async (reset) => (await fetch(`http://127.0.0.1:${PORT}/__stats${reset ? '?reset=1' : ''}`)).json();
const results = [];
for (const j of jobs) {
  await stats(true);
  const before = (await stats(false)).outbound;
  const t0 = Date.now(); let status = 0; let body = '';
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 330_000);
    const r = await fetch(`http://127.0.0.1:${PORT}${j.path}`, { headers: { authorization: 'Bearer load-cron-secret' }, signal: ctl.signal });
    clearTimeout(timer); status = r.status; body = (await r.text()).slice(0, 300);
  } catch (e) { status = 599; body = String(e.message); }
  const secs = (Date.now() - t0) / 1000;
  const s = await stats(false);
  const q = s.queries.reduce((a, x) => a + x.n, 0);
  const slow = s.queries.map((x) => ({ ...x, avg: x.total / x.n })).sort((a, b) => b.max - a.max)[0];
  const row = { job: j.path.replace('/api/cron/', ''), schedule: j.schedule, status, secs, queries: q, emails: s.outbound.email - before.email, texts: s.outbound.sms - before.sms, slowest: slow ? { ms: Math.round(slow.max), text: slow.text.slice(0, 140) } : null, body };
  results.push(row);
  console.log(`${row.job.padEnd(26)} ${String(status).padEnd(4)} ${secs.toFixed(1).padStart(7)}s  ${String(q).padStart(7)} queries  ${String(row.emails).padStart(5)} emails  slowest ${slow ? Math.round(slow.max) + 'ms' : '-'}  ${body.replace(/\s+/g, ' ').slice(0, 110)}`);
  fs.writeFileSync(`${OUT}/crons-${process.env.RUN || 'run'}.json`, JSON.stringify(results, null, 1));
}
process.exit(0);
