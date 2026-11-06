// Builds marketing-sitemap.xml from the route list in marketing-routes.mjs.
// <lastmod> is the last git commit that touched the page's source files;
// when git is not available (a CLI deploy uploads the tree without .git)
// the tag is simply left out, which is valid.
import { spawnSync } from 'node:child_process';
import { ROOT, SITE_ORIGIN, sitemapEntries } from './marketing-routes.mjs';

let gitOk = null;
function gitAvailable() {
  if (gitOk === null) {
    const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' });
    gitOk = r.status === 0 && r.stdout.trim() === 'true';
  }
  return gitOk;
}

const dateCache = new Map();
export function lastCommitDate(files) {
  if (!gitAvailable()) return null;
  let latest = null;
  for (const f of files) {
    if (!dateCache.has(f)) {
      const r = spawnSync('git', ['log', '-1', '--format=%cI', '--', f], { cwd: ROOT, encoding: 'utf8' });
      dateCache.set(f, r.status === 0 ? r.stdout.trim() || null : null);
    }
    const d = dateCache.get(f);
    if (d && (!latest || d > latest)) latest = d;
  }
  return latest ? latest.slice(0, 10) : null;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildSitemapXml() {
  const urls = sitemapEntries().map((e) => {
    const lastmod = lastCommitDate(e.sources);
    return [
      '  <url>',
      `    <loc>${esc(SITE_ORIGIN + e.path)}</loc>`,
      lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
      `    <priority>${e.priority}</priority>`,
      '  </url>',
    ].filter(Boolean).join('\n');
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
