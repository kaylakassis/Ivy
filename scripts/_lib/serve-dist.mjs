// Tiny static server over dist/ for the build and its checks.
//
//   mode 'spa'    - what the pre-render step needs: any path that is not a
//                   file gets index.html, exactly like the SPA catch-all.
//   mode 'vercel' - what tests/prerender.test.mjs needs: the request goes
//                   through the same stages as on Vercel, in order:
//                   middleware.js (for its matcher), then the filesystem
//                   (index.html for "/"), then vercel.json rewrites in order
//                   (with their `has` host conditions), each re-checked
//                   against the filesystem.
//
// /api/* is stubbed in both modes: the two endpoints the public pages call
// on load answer the way production does for a logged-out visitor, and
// every other API path is a 404. Nothing here talks to a database.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.webmanifest': 'application/manifest+json', '.map': 'application/json',
};

function apiStub(pathname, res) {
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (pathname === '/api/early-access/status') {
    return json(200, { enabled: false, unlocked: true, launchMode: 'open', hasBetaPassword: false, bypassed: false });
  }
  if (pathname === '/api/auth/me') return json(401, { error: 'Unauthorized' });
  return json(404, { error: 'Not found' });
}

// Vercel's rewrite `source` syntax: `:name` params and literal regex groups
// (a `.` is literal outside a group, regex inside one).
function compileSource(source) {
  const names = [];
  let re = '';
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ':' && depth === 0) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      names.push(source.slice(i + 1, j));
      re += '([^/]+)';
      i = j - 1;
    } else if (c === '.' && depth === 0) {
      re += '\\.';
    } else {
      re += c;
    }
  }
  return { re: new RegExp(`^${re}$`), names };
}

function matchRewrite(rule, pathname, host) {
  const { re, names } = compileSource(rule.source);
  const m = re.exec(pathname);
  if (!m) return null;
  for (const cond of rule.has || []) {
    if (cond.type === 'host') {
      if (!new RegExp(`^${cond.value}$`).test(host)) return null;
    } else {
      return null; // other condition types are not used by this project
    }
  }
  let dest = rule.destination;
  names.forEach((n, i) => { dest = dest.split(`:${n}`).join(m[i + 1]); });
  return dest;
}

// Resolve a URL path to a file under dist (index.html for directories).
function fileFor(dist, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { return null; }
  const abs = path.join(dist, p);
  if (!abs.startsWith(dist)) return null;
  try {
    const st = fs.statSync(abs);
    if (st.isFile()) return abs;
    if (st.isDirectory()) {
      const idx = path.join(abs, 'index.html');
      if (fs.existsSync(idx)) return idx;
    }
  } catch { /* not there */ }
  return null;
}

function send(res, file, status = 200, extra = {}) {
  const ext = path.extname(file).toLowerCase();
  res.writeHead(status, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', ...extra });
  fs.createReadStream(file).pipe(res);
}

// vercel.json `headers` whose source matches the request path (so the
// checks see the real Content-Security-Policy and friends).
function headersFor(rules, pathname) {
  const out = {};
  for (const rule of rules || []) {
    if (!compileSource(rule.source).re.test(pathname)) continue;
    for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

// Convert a middleware `matcher` entry to a regex (`/api/:path*` style).
function matcherRegex(m) {
  const re = m.replace(/\/:([A-Za-z0-9_]+)\*/g, '(?:/.*)?').replace(/:([A-Za-z0-9_]+)/g, '[^/]+');
  return new RegExp(`^${re}$`);
}

export async function startDistServer({ dist, mode = 'spa', vercelConfig = null, middleware = null, host = 'www.joinivy.ai' }) {
  const DIST = path.resolve(dist);
  const rewrites = vercelConfig?.rewrites || [];
  const matchers = middleware?.config?.matcher
    ? [].concat(middleware.config.matcher).map(matcherRegex) : [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let pathname = url.pathname;
    const reqHost = mode === 'vercel' ? host : (req.headers.host || 'localhost');

    if (pathname.startsWith('/api/')) return apiStub(pathname, res);

    if (mode === 'spa') {
      const f = fileFor(DIST, pathname) || path.join(DIST, 'index.html');
      return send(res, f);
    }

    // ── 'vercel' mode ──
    if (middleware && matchers.some((re) => re.test(pathname))) {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      headers.set('host', reqHost);
      headers.set('x-forwarded-host', reqHost);
      const request = new Request(`https://${reqHost}${req.url}`, { method: req.method, headers });
      const out = await middleware.default(request);
      const rewritten = out?.headers?.get('x-middleware-rewrite');
      if (rewritten) pathname = new URL(rewritten).pathname;
      else if (!out?.headers?.get('x-middleware-next')) {
        res.writeHead(out.status, Object.fromEntries(out.headers));
        return res.end(Buffer.from(await out.arrayBuffer()));
      }
    }

    let file = fileFor(DIST, pathname);
    if (!file) {
      let current = pathname;
      for (const rule of rewrites) {
        const dest = matchRewrite(rule, current, reqHost);
        if (!dest) continue;
        const destPath = new URL(dest, 'http://x').pathname;
        if (destPath.startsWith('/api/')) return apiStub(destPath, res);
        const f = fileFor(DIST, destPath);
        if (f) { file = f; break; }
        current = destPath; // check:true - keep matching with the rewritten path
      }
    }
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    return send(res, file, 200, headersFor(vercelConfig?.headers, url.pathname));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
