// Stand-in for the hosted database driver during the load test. Same
// surface the app uses, but (a) a POOL of connections like the hosted
// database's pooler, not one connection, and (b) every query is timed and
// counted, per query text and per request.
import pkg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
const { Pool } = pkg;
export const requestCtx = new AsyncLocalStorage();
export const queryStats = new Map();   // normalised text -> { n, total, max }
let pool;
const norm = (t) => String(t).replace(/\s+/g, ' ').trim().slice(0, 300);
// Simulated network distance to the database, per query (ms). The hosted
// driver makes one HTTPS round trip per query.
const HOP = Number(process.env.DB_HOP_MS || 0);
export function neon(connectionString, opts = {}) {
  const fullResults = !!opts.fullResults;
  pool ||= new Pool({ connectionString, max: Number(process.env.DB_POOL || 20) });
  async function runText(text, params = []) {
    const t0 = performance.now();
    if (HOP) await new Promise((r) => setTimeout(r, HOP));
    let r;
    try { r = await pool.query(text, params); }
    finally {
      const ms = performance.now() - t0;
      const k = norm(text); const s = queryStats.get(k) || { n: 0, total: 0, max: 0 };
      s.n++; s.total += ms; if (ms > s.max) s.max = ms; queryStats.set(k, s);
      const ctx = requestCtx.getStore(); if (ctx) { ctx.q++; ctx.dbMs += ms; }
    }
    return fullResults ? { rows: r.rows, rowCount: r.rowCount } : r.rows;
  }
  function tagged(strings, ...values) {
    let text = ''; const params = [];
    for (let i = 0; i < strings.length; i++) { text += strings[i]; if (i < values.length) { params.push(values[i]); text += `$${params.length}`; } }
    return runText(text, params);
  }
  tagged.query = (text, params) => runText(text, params);
  return tagged;
}
export const neonConfig = {};
export function poolStats() { return pool ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } : null; }
