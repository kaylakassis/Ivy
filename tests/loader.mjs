// Node loader hook that redirects @neondatabase/serverless to a local
// pg-backed shim. Lets the same handlers that run on Vercel + Neon also
// run against a local Postgres in tests without code changes.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const SHIM = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'neon-shim.mjs'),
).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@neondatabase/serverless') {
    return { url: SHIM, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
