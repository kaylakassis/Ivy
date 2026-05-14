// pg-backed shim for @neondatabase/serverless. Used by the local test
// rig so handlers that `import { neon } from '@neondatabase/serverless'`
// transparently talk to a local Postgres instead of the Neon HTTP API.
//
// API surface kept minimal — we only export what the app actually uses:
//   • neon(connectionString, opts)
//       Returns a tagged-template function `sql` with .query(text, params)
//       attached. When opts.fullResults is true, the tagged invocation
//       returns { rows, rowCount, ... } (Neon's "full results" mode).
import pkg from 'pg';
const { Client } = pkg;

const clients = new Map();
async function getClient(connStr) {
  if (clients.has(connStr)) return clients.get(connStr);
  const client = new Client({ connectionString: connStr });
  await client.connect();
  clients.set(connStr, client);
  return client;
}

// Cleanup on process exit so we don't leak connections between test
// runs.
process.on('exit', () => {
  for (const c of clients.values()) {
    try { c.end(); } catch {}
  }
});

export function neon(connectionString, opts = {}) {
  const fullResults = !!opts.fullResults;

  async function runText(text, params = []) {
    const client = await getClient(connectionString);
    const r = await client.query(text, params);
    return fullResults
      ? { rows: r.rows, rowCount: r.rowCount }
      : r.rows;
  }

  function tagged(strings, ...values) {
    // Translate the tagged template into a parameterized query. Neon's
    // tagged form uses ${...} which we splice in as $1, $2, ... — this
    // matches the pg driver convention. JSON.stringify(obj)::jsonb etc.
    // is handled by the caller passing strings, so we just need to
    // weave parameters in.
    let text = '';
    const params = [];
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) {
        params.push(values[i]);
        text += `$${params.length}`;
      }
    }
    return runText(text, params);
  }

  // .query(text, params) for callers that pre-built SQL strings.
  tagged.query = (text, params) => runText(text, params);

  return tagged;
}

// Some callers do `import { Pool } from '@neondatabase/serverless'` for
// streaming queries — we don't, but stub it so re-exports don't break.
export class Pool {}
