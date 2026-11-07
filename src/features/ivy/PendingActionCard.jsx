// One-tap approval card for an action Ivy proposed that is outbound or hard
// to reverse (send a message, send an invoice, change settings…). The server
// records each proposed call and returns it as `pendingActions` on Ivy's
// message, each with its `id`. Approve calls POST /api/ivy/approve with that
// id, the only path that runs the stored call; Dismiss declines it. Renders
// nothing when there's nothing pending.
//
// Motion: the border glows once (600ms) when the card mounts so the owner's
// eye lands on the thing that needs a decision; Approve flashes green.
import React from 'react';
import { Icons } from '../../components/Icons.jsx';
import { useSuccessFlash } from '../../components/motion/useSuccessFlash.js';
import { safeBackground, safeHeadlineGradient } from '../website/styleSafety.js';

// Website style changes carry colour chips ({ label, color }) so the owner
// sees the colour itself, never a bare code. Only the editor's own swatch
// values or a plain #rrggbb are painted; anything else is skipped.
export function ColorChips({ swatches }) {
  const list = (Array.isArray(swatches) ? swatches : [])
    .filter((s) => s && typeof s.label === 'string' && (safeBackground(s.color) || safeHeadlineGradient(s.color)))
    .slice(0, 4);
  if (!list.length) return null;
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
      {list.map((s, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--fg-2)' }}>
          <span aria-hidden="true" data-testid="color-chip" style={{
            width: 18, height: 18, borderRadius: 5, flexShrink: 0,
            border: '1px solid var(--border-strong)', background: safeBackground(s.color) || safeHeadlineGradient(s.color),
          }}/>
          {s.label}
        </span>
      ))}
    </span>
  );
}

export default function PendingActionCard({ actions, onApprove, onDismiss, busy }) {
  const [approveFlash, flashApprove] = useSuccessFlash();
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const many = actions.length > 1;
  return (
    <div className="glow-once" style={{
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
          <li key={i} style={{ fontSize: 12.5, color: 'var(--fg)', lineHeight: 1.4, whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
            {a.summary || a.action}
            <ColorChips swatches={a.swatches}/>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className={`btn btn-primary ${approveFlash}`} disabled={busy}
          onClick={() => { flashApprove(); onApprove?.(); }} style={{ padding: '7px 14px', fontSize: 12.5, gap: 6 }}>
          <Icons.Check size={13} sw={2.2}/> Approve
        </button>
        <button type="button" className="btn btn-outline" disabled={busy}
          onClick={onDismiss} style={{ padding: '7px 14px', fontSize: 12.5 }}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
