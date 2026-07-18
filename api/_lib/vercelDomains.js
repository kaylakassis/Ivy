// Vercel project domain management for business-owner custom domains.
//
// When an owner connects a custom domain to their site, the domain must
// be ATTACHED to our Vercel project for Vercel to terminate TLS and route
// the host to our deployment. Without it, Vercel answers the host with its
// own "domain not configured" error before our code ever runs.
//
// All three calls are GUARDED: if VERCEL_TOKEN / VERCEL_PROJECT_ID aren't
// set, they no-op with { configured: false } so DNS verification still
// works and the operator can attach domains by hand in the dashboard.
//
// Token + project id come from Vercel → Account/Team Settings → Tokens and
// Project → Settings → General. VERCEL_TEAM_ID is only needed when the
// project lives under a Team.
import { fetchWithTimeout } from './fetchTimeout.js';

function creds() {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) return null;
  const teamQ = process.env.VERCEL_TEAM_ID
    ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}`
    : '';
  return { token, projectId, teamQ };
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Attach a domain to the project. Idempotent: a 409 means it's already
// attached, which we treat as success.
export async function addProjectDomain(name) {
  const c = creds();
  if (!c) return { configured: false };
  try {
    const r = await fetchWithTimeout(
      `https://api.vercel.com/v10/projects/${encodeURIComponent(c.projectId)}/domains${c.teamQ}`,
      { method: 'POST', headers: authHeaders(c.token), body: JSON.stringify({ name }) },
    );
    if (r.ok || r.status === 409) return { configured: true, ok: true };
    const body = await r.text().catch(() => '');
    return { configured: true, ok: false, reason: `vercel ${r.status}: ${body.slice(0, 160)}` };
  } catch (e) {
    return { configured: true, ok: false, reason: e.message || 'request failed' };
  }
}

// Detach a domain from the project (when an owner changes/clears it).
// 404 = already gone, treated as success. Best-effort.
export async function removeProjectDomain(name) {
  const c = creds();
  if (!c || !name) return { configured: false };
  try {
    const r = await fetchWithTimeout(
      `https://api.vercel.com/v9/projects/${encodeURIComponent(c.projectId)}/domains/${encodeURIComponent(name)}${c.teamQ}`,
      { method: 'DELETE', headers: authHeaders(c.token) },
    );
    if (r.ok || r.status === 404) return { configured: true, ok: true };
    const body = await r.text().catch(() => '');
    return { configured: true, ok: false, reason: `vercel ${r.status}: ${body.slice(0, 160)}` };
  } catch (e) {
    return { configured: true, ok: false, reason: e.message || 'request failed' };
  }
}

// Ask Vercel whether the domain is correctly configured + serving (TLS
// issued). `misconfigured: false` means it's live. Returns
// { configured, live } - `live` is null when we can't tell.
export async function getDomainConfig(name) {
  const c = creds();
  if (!c || !name) return { configured: false, live: null };
  try {
    const r = await fetchWithTimeout(
      `https://api.vercel.com/v6/domains/${encodeURIComponent(name)}/config${c.teamQ}`,
      { headers: authHeaders(c.token) },
    );
    if (!r.ok) return { configured: true, live: null };
    const data = await r.json().catch(() => null);
    // `misconfigured` is true while DNS/cert isn't ready; false once live.
    const live = data && typeof data.misconfigured === 'boolean' ? !data.misconfigured : null;
    return { configured: true, live };
  } catch {
    return { configured: true, live: null };
  }
}
