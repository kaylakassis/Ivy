// "What I did": the server's record of what Ivy's tools actually did in the
// turn this reply belongs to (message.actions, see api/_lib/ivyLedger.js),
// shown as a short list under her reply. It comes from the tool results, not
// from her words, so the owner can see at a glance what really changed and
// what did not. Waiting-for-approval items are left to the approval card;
// lines the reply already says word for word are not repeated.
import React from 'react';
import { Icons } from '../../components/Icons.jsx';

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/\.$/, '').toLowerCase();

export function visibleActions(msg) {
  const list = Array.isArray(msg?.actions) ? msg.actions : [];
  const text = norm(msg?.text);
  return list.filter((a) => (a?.status === 'done' || a?.status === 'failed')
    && a.summary && !text.includes(norm(String(a.summary).split('\n')[0])));
}

export default function ActionLedger({ msg, indent = 0, maxWidth = '88%' }) {
  const items = visibleActions(msg);
  if (!items.length) return null;
  return (
    <div style={{
      marginTop: 6, marginLeft: indent, padding: '8px 10px', borderRadius: 10, width: 'fit-content',
      border: '1px solid var(--border)', background: 'var(--surface-2)',
      display: 'flex', flexDirection: 'column', gap: 5, maxWidth, boxSizing: 'border-box',
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', letterSpacing: 0.2 }}>What I did</div>
      {items.map((a, i) => {
        const ok = a.status === 'done';
        return (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, lineHeight: 1.4, color: 'var(--fg-2)' }}>
            <span style={{ flex: '0 0 auto', marginTop: 2, color: ok ? 'var(--ok)' : 'var(--danger)' }}>
              {ok ? <Icons.Check size={12} sw={2.2}/> : <Icons.X size={12} sw={2.2}/>}
            </span>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {String(a.summary).split('\n')[0]}
              {!ok && a.error ? <span style={{ color: 'var(--muted)' }}>{`: didn't work (${a.error})`}</span> : null}
              {ok && Array.isArray(a.warnings) && a.warnings.length > 0 && (
                <span style={{ display: 'block', color: 'var(--muted)' }}>{a.warnings.join(' ')}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
