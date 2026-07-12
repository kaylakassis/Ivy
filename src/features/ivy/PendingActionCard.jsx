// One-tap confirmation card for an action Ivy proposed that is outbound or
// hard to reverse (send a message, send an invoice, change settings…). Ivy's
// server-side confirm-gate returns these as `pendingActions` on her message.
// Approving sends the owner's OWN explicit approval through the normal chat
// path — the model then re-issues the tool with confirm:true — so this is
// just a faster "yes", not a new execution path, and the security model is
// unchanged. Renders nothing when there's nothing pending.
import React from 'react';
import { Icons } from '../../components/Icons.jsx';

export default function PendingActionCard({ actions, onApprove, onDismiss, busy }) {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const many = actions.length > 1;
  return (
    <div style={{
      marginTop: 8,
      border: '1px solid var(--border-strong)', borderRadius: 12,
      background: 'var(--surface-2)', padding: 12,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: 'var(--fg-2)' }}>
        <Icons.Spark size={13} sw={1.9}/>
        {many ? `Approve ${actions.length} actions?` : 'Approve this action?'}
      </div>
      <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {actions.map((a, i) => (
          <li key={i} style={{ fontSize: 12.5, color: 'var(--fg)', lineHeight: 1.4 }}>
            {a.summary || a.action}
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" disabled={busy}
          onClick={onApprove} style={{ padding: '7px 14px', fontSize: 12.5, gap: 6 }}>
          <Icons.Check size={13} sw={2.2}/> Approve &amp; send
        </button>
        <button type="button" className="btn btn-outline" disabled={busy}
          onClick={onDismiss} style={{ padding: '7px 14px', fontSize: 12.5 }}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
