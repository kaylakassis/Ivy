// Redirect the hosted database driver to the load-test stand-in, and let
// the stand-in find the repo's own `pg` package.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const SHIM = new URL('./shim.mjs', import.meta.url).href;
const REPO = pathToFileURL(path.join(process.cwd(), 'package.json')).href;
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@neondatabase/serverless') return { url: SHIM, format: 'module', shortCircuit: true };
  if (specifier === 'pg' && context.parentURL === SHIM) return nextResolve(specifier, { ...context, parentURL: REPO });
  return nextResolve(specifier, context);
}
