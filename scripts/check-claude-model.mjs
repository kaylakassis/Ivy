// scripts/check-claude-model.mjs
//
// Polls Anthropic's models API for the highest-versioned Claude Opus
// model and, if it's newer than the IVY_MODEL constant in
// api/_lib/ivy.js, rewrites the constant in place. Designed to be run
// by the GHA in .github/workflows/check-claude-model.yml — that
// workflow handles opening the PR if this script changes the file.
//
// Required env:
//   ANTHROPIC_API_KEY  (read-only key works fine — only hits GET /v1/models)
//
// Optional env:
//   GITHUB_OUTPUT      (the workflow appends key=value pairs for downstream
//                       steps; if unset, the script just prints to stderr)
//
// Exit codes:
//   0 — ran cleanly. Whether the file changed is in GITHUB_OUTPUT's
//       `bumped` field (true/false). The workflow keys off that.
//   1 — script error (network down, API rejected key, file shape changed
//       and the regex couldn't find IVY_MODEL, etc.). The workflow run
//       fails loudly so the operator sees it.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const IVY_FILE = path.join(here, '..', 'api', '_lib', 'ivy.js');
// IVY_MODEL is the SINGLE source of truth — UI label, billing log, and
// the API call all read from it. Only Opus is in scope: Ivy is
// deliberately on Anthropic's flagship tier; if the team decides to
// shift to Sonnet/Haiku that's a manual product decision, not an
// auto-bump candidate.
const FAMILY = 'opus';

// Pattern of the IVY_MODEL line. Captures the model id so we can compare
// to whatever Anthropic returns. Tolerates `export const` or plain `const`
// to survive the previous refactor.
const MODEL_LINE_RE = /(export\s+)?const\s+IVY_MODEL\s*=\s*['"]([^'"]+)['"]/;

// Matches the rolling "marketing name" form like `claude-opus-4-8`.
// Deliberately excludes date-pinned variants such as
// `claude-opus-4-8-20251201` — those are for explicit pinning, not the
// rolling alias Ivy uses. If Anthropic ever changes the naming scheme,
// the GHA will fail loudly here and the operator will notice in the
// scheduled-run failure email.
const VERSION_RE = new RegExp(`^claude-${FAMILY}-(\\d+)-(\\d+)$`);

function output(key, value) {
  const line = `${key}=${value}`;
  // Always log so the GHA run log shows what happened.
  console.log(line);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, line + '\n');
  }
}

function die(msg) {
  console.error('::error::' + msg);
  process.exit(1);
}

async function fetchModels() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) die('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    die(`Anthropic /v1/models returned ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return Array.isArray(json?.data) ? json.data : [];
}

function pickLatestOpus(models) {
  const candidates = [];
  for (const m of models) {
    const id = m?.id || '';
    const match = VERSION_RE.exec(id);
    if (!match) continue;
    candidates.push({ id, major: parseInt(match[1], 10), minor: parseInt(match[2], 10) });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.major - a.major) || (b.minor - a.minor));
  return candidates[0];
}

function parseVersion(id) {
  const m = VERSION_RE.exec(id);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
}

function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  return a.minor - b.minor;
}

async function main() {
  const src = readFileSync(IVY_FILE, 'utf8');
  const m = MODEL_LINE_RE.exec(src);
  if (!m) die(`Could not find IVY_MODEL declaration in ${IVY_FILE}`);
  const currentId = m[2];
  output('current', currentId);

  const currentVer = parseVersion(currentId);
  if (!currentVer) {
    // The current pin uses a shape the script doesn't understand
    // (date-pinned, alias, future format). Surface it; the operator
    // can decide whether to update by hand.
    output('bumped', 'false');
    output('reason', `current IVY_MODEL "${currentId}" doesn't match expected pattern; skipping auto-bump`);
    return;
  }

  const models = await fetchModels();
  const latest = pickLatestOpus(models);
  if (!latest) die(`No claude-${FAMILY}-*-* models returned by Anthropic API`);
  output('latest', latest.id);

  const diff = compareVersions(latest, currentVer);
  if (diff <= 0) {
    // Already on the latest (or somehow ahead — unusual but harmless).
    output('bumped', 'false');
    return;
  }

  const isMajorBump = latest.major > currentVer.major;
  output('is_major_bump', String(isMajorBump));

  // Rewrite the file. We only touch the captured string in the IVY_MODEL
  // line — everything else (export keyword, surrounding whitespace,
  // adjacent comments) is preserved exactly so the diff stays one line.
  const updated = src.replace(MODEL_LINE_RE, (line) =>
    line.replace(currentId, latest.id),
  );
  if (updated === src) die('Rewrite produced no change — refusing to commit a no-op');
  writeFileSync(IVY_FILE, updated);
  output('bumped', 'true');
}

main().catch((err) => die(err?.message || String(err)));
