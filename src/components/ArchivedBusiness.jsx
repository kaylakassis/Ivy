// "This business is no longer on Ivy" surfaces.
//
// Shown wherever a client (or a visitor) reaches a business whose owner's
// subscription has lapsed: the public booking page, the embed widgets,
// the website, program sales pages and the client portal. The copy is
// shared with the API (api/_lib/businessAccess.js) so every surface says
// the same thing, and the state reverses on its own when the owner
// resubscribes.
import React from 'react';
import { Link } from 'react-router-dom';

export const ARCHIVED_MESSAGE = 'This business is no longer available to book with on Ivy.';
export const ARCHIVED_PROMPT = 'Want to see what else is out there?';
export const DISCOVER_PATH = '/me/discover';
export const DISCOVER_LABEL = 'Check out Discover';

// Is this API error the archived 403? The api.js helper keeps the parsed
// body on err.details; raw fetch callers pass the parsed JSON instead.
export function isArchivedError(err) {
  const code = err?.details?.code || err?.code;
  return err?.status === 403 && code === 'business_archived';
}

// Full-page card for public pages. `compact` is the embed/iframe variant:
// tighter padding and a plain anchor that breaks out of the iframe.
export default function ArchivedBusinessCard({ businessName, compact = false }) {
  const name = businessName || 'This business';
  return (
    <div className="card" role="status" style={{
      padding: compact ? '22px 20px' : '40px 32px',
      textAlign: 'center', maxWidth: compact ? 'none' : 480, margin: compact ? 0 : '0 auto',
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12, margin: '0 auto 14px',
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18, color: 'var(--muted)',
      }}>{name[0].toUpperCase()}</div>
      <h1 style={{
        margin: 0, fontSize: compact ? 18 : 22, fontWeight: 600,
        letterSpacing: '-0.01em', color: 'var(--fg)',
      }}>{name}</h1>
      <p style={{ margin: '10px 0 0', fontSize: compact ? 13.5 : 15, lineHeight: 1.55, color: 'var(--fg-2)' }}>
        {ARCHIVED_MESSAGE}
      </p>
      <p style={{ margin: '6px 0 0', fontSize: compact ? 13 : 14, lineHeight: 1.55, color: 'var(--muted)' }}>
        {ARCHIVED_PROMPT}
      </p>
      {compact ? (
        <a href={DISCOVER_PATH} target="_top" className="btn btn-primary"
          style={{ marginTop: 18, padding: '10px 18px', fontSize: 13.5 }}>
          {DISCOVER_LABEL}
        </a>
      ) : (
        <Link to={DISCOVER_PATH} className="btn btn-primary"
          style={{ marginTop: 22, padding: '12px 22px', fontSize: 14 }}>
          {DISCOVER_LABEL}
        </Link>
      )}
    </div>
  );
}

// One-line variant for inside the client portal (a business row, a
// thread composer, a booking row): the message plus a Discover link.
export function ArchivedNotice({ text = ARCHIVED_MESSAGE, style }) {
  return (
    <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, ...style }}>
      {text}{' '}
      <Link to={DISCOVER_PATH} style={{ color: 'var(--accent)', fontWeight: 600, textDecoration: 'none' }}>
        {DISCOVER_LABEL}
      </Link>
    </div>
  );
}

// Muted badge next to a business name in the portal.
export function ArchivedBadge() {
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 99,
      background: 'var(--surface)', color: 'var(--muted)', border: '1px solid var(--border)',
      textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
    }}>No longer on Ivy</span>
  );
}
