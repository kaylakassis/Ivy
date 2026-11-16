// API-only server for the load test: routes /api/* to the real handlers
// and records, per route, how long each request took, how much of that was
// database time, and how many queries it ran.
//   node --import <load>/bootstrap.mjs <load>/server.mjs     (run from the repo root)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { requestCtx, queryStats, poolStats } from './shim.mjs';

const API = path.join(process.cwd(), 'api');
const PORT = Number(process.env.PORT || 5500);
const routes = new Map();    // "GET clients/index" -> { n, err, ms: [], db: [], q: [] }
const dirCache = new Map();
const ls = (d) => { if (!dirCache.has(d)) dirCache.set(d, fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []); return dirCache.get(d); };

function resolveApi(urlPath) {
  const segs = urlPath.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const params = {}; let dir = API;
  for (let i = 0; i < segs.length; i++) {
    const seg = decodeURIComponent(segs[i]); const last = i === segs.length - 1; const entries = ls(dir);
    const has = (n) => entries.find((e) => e.name === n);
    if (last) {
      if (has(`${seg}.js`)) return { file: path.join(dir, `${seg}.js`), params };
      if (has(seg)?.isDirectory() && ls(path.join(dir, seg)).find((e) => e.name === 'index.js')) return { file: path.join(dir, seg, 'index.js'), params };
      const dynFile = entries.find((e) => /^\[.+\]\.js$/.test(e.name));
      if (dynFile) { params[dynFile.name.slice(1, -4)] = seg; return { file: path.join(dir, dynFile.name), params }; }
      const dynDir = entries.find((e) => /^\[.+\]$/.test(e.name) && e.isDirectory() && ls(path.join(dir, e.name)).find((x) => x.name === 'index.js'));
      if (dynDir) { params[dynDir.name.slice(1, -1)] = seg; return { file: path.join(dir, dynDir.name, 'index.js'), params }; }
      return null;
    }
    if (has(seg)?.isDirectory()) { dir = path.join(dir, seg); continue; }
    const dynDir = entries.find((e) => /^\[.+\]$/.test(e.name) && e.isDirectory());
    if (dynDir) { params[dynDir.name.slice(1, -1)] = seg; dir = path.join(dir, dynDir.name); continue; }
    return null;
  }
  if (ls(dir).find((e) => e.name === 'index.js')) return { file: path.join(dir, 'index.js'), params };
  return null;
}
const modules = new Map();
const loadHandler = async (file) => { if (!modules.has(file)) modules.set(file, import(pathToFileURL(file).href)); return (await modules.get(file)).default; };
const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { if (!d) return resolve(undefined); try { resolve(JSON.parse(d)); } catch { resolve(d); } }); req.on('error', () => resolve(undefined)); });
const errors = new Map();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__stats') {
    const out = {
      routes: Object.fromEntries([...routes].map(([k, v]) => [k, v])),
      queries: [...queryStats].map(([text, s]) => ({ text, ...s })),
      pool: poolStats(), outbound: globalThis.__loadOutbound, errors: Object.fromEntries(errors),
      mem: Math.round(process.memoryUsage().rss / 1e6),
    };
    if (url.searchParams.get('reset')) { routes.clear(); queryStats.clear(); errors.clear(); }
    res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(out));
  }
  const hit = url.pathname.startsWith('/api/') ? resolveApi(url.pathname) : null;
  if (!hit) { res.statusCode = 404; return res.end('{"error":"Not found"}'); }
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  res.send = (s) => { res.end(typeof s === 'string' || Buffer.isBuffer(s) ? s : JSON.stringify(s)); return res; };
  req.query = { ...Object.fromEntries(url.searchParams.entries()), ...hit.params };
  if (String(req.headers['content-type'] || '').includes('application/json') && !['GET', 'HEAD'].includes(req.method)) req.body = await readBody(req);
  const key = `${req.method} ${path.relative(API, hit.file).replace(/\.js$/, '')}${req.headers['x-load-tag'] ? ' #' + req.headers['x-load-tag'] : ''}`;
  const ctx = { q: 0, dbMs: 0 };
  const t0 = performance.now();
  await requestCtx.run(ctx, async () => {
    try { const handler = await loadHandler(hit.file); await handler(req, res); if (!res.writableEnded) res.end(); }
    catch (err) {
      errors.set(key, { n: (errors.get(key)?.n || 0) + 1, last: String(err?.message || err).slice(0, 200) });
      if (!res.headersSent) { res.statusCode = 500; res.setHeader('content-type', 'application/json'); }
      if (!res.writableEnded) res.end(JSON.stringify({ error: err.message }));
    }
  });
  const ms = performance.now() - t0;
  const r = routes.get(key) || { n: 0, err: 0, s4: 0, ms: [], db: [], q: [] };
  r.n++; if (res.statusCode >= 500) r.err++; else if (res.statusCode >= 400) r.s4++;
  if (r.ms.length < 20000) { r.ms.push(Math.round(ms * 10) / 10); r.db.push(Math.round(ctx.dbMs * 10) / 10); r.q.push(ctx.q); }
  routes.set(key, r);
});
server.listen(PORT, () => console.log(`[load-server] :${PORT} pid ${process.pid}`));
