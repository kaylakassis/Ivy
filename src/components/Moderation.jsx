// Shared report + block UI used by the owner Messages page, the client
// portal Messages page, and the Account / Profile "Blocked" and
// "Reports" cards. Apple App Review requires both affordances anywhere
// people can write to each other; keeping them in one place means the
// two sides of a conversation get the same words and the same shapes.
import React, { useEffect, useRef, useState } from 'react';
import { Icons } from './Icons.jsx';
import { api } from '../lib/api.js';
import { useEscapeKey } from '../lib/useEscapeKey.js';

export const REPORT_REASONS = [
  { id: 'harassment',    label: 'Harassment' },
  { id: 'spam',          label: 'Spam' },
  { id: 'inappropriate', label: 'Inappropriate content' },
  { id: 'scam',          label: 'Scam or fraud' },
  { id: 'other',         label: 'Other' },
];

const TARGET_LABELS = {
  client: 'Contact',
  business: 'Business',
  message: 'Message',
  group_message: 'Group message',
  review: 'Review',
};

// "⋯" button that opens a small menu. items: [{ label, onClick, danger }]
export function MoreMenu({ items, label = 'More options' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('touchstart', onDoc);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" className="btn btn-ghost" aria-label={label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)} style={{ padding: 6 }}>
        <Icons.More size={16} sw={2}/>
      </button>
      {open && (
        <div role="menu" className="card" style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 60,
          minWidth: 200, padding: 6, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.18))',
        }}>
          {items.filter(Boolean).map((it) => (
            <button key={it.label} type="button" role="menuitem"
              onClick={() => { setOpen(false); it.onClick?.(); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '9px 10px', borderRadius: 8, fontSize: 13,
                background: 'transparent', border: 0, cursor: 'pointer',
                color: it.danger ? 'var(--danger)' : 'var(--fg)',
              }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Report dialog: reason + optional details → onSubmit(reason, details).
// Shows a thank-you once the report is filed.
export function ReportModal({ title, onSubmit, onClose }) {
  useEscapeKey(onClose);
  const [reason, setReason] = useState('harassment');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await onSubmit(reason, details.trim());
      setDone(true);
    } catch (e2) {
      setErr(e2?.message || 'Could not send the report. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={onClose} role="dialog" aria-modal="true" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card" style={{
        padding: 0, width: '100%', maxWidth: 440, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>{title}</h3>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }} aria-label="Close"><Icons.X size={15}/></button>
        </div>
        {done ? (
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600 }}>
              <Icons.Check size={16} stroke="var(--ok)"/> Thanks, we&apos;ll review this.
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
              Our team looks at every report within 24 hours. If you want to stop hearing from them in the meantime, you can block them.
            </div>
            <div><button type="button" className="btn btn-primary" onClick={onClose}>Done</button></div>
          </div>
        ) : (
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Reason</span>
              <select className="input" value={reason} onChange={(e) => setReason(e.target.value)} style={{ padding: '9px 12px', fontSize: 14 }}>
                {REPORT_REASONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Details (optional)</span>
              <textarea className="input" value={details} onChange={(e) => setDetails(e.target.value)}
                rows={4} maxLength={2000} placeholder="What happened?"
                style={{ padding: '9px 12px', fontSize: 14, resize: 'vertical', minHeight: 80 }}/>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{details.length}/2000</span>
            </label>
            {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Submit report'}</button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

// One-line replacement for a composer when messaging is switched off.
export function BlockedNotice({ text, actionLabel, onAction, busy }) {
  return (
    <div style={{
      padding: '14px 20px', borderTop: '1px solid var(--border)', background: 'var(--surface)',
      fontSize: 13, color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap',
    }}>
      <Icons.EyeOff size={14}/>
      <span>{text}</span>
      {onAction && (
        <button type="button" className="btn btn-outline" onClick={onAction} disabled={busy} style={{ padding: '4px 10px', fontSize: 12.5 }}>
          {busy ? '…' : actionLabel}
        </button>
      )}
    </div>
  );
}

export function StatusBadge({ status }) {
  const tone = status === 'open' ? 'var(--warn)' : status === 'reviewed' ? 'var(--ok)' : 'var(--muted)';
  const label = status === 'open' ? 'Open' : status === 'reviewed' ? 'Reviewed' : 'Dismissed';
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
      padding: '2px 8px', borderRadius: 99,
      background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone, whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

export function targetLabel(t) { return TARGET_LABELS[t] || t; }

// "Blocked" settings card. `load` returns the list; `labelOf(row)` is the
// display name; `unblock(row)` removes the block.
export function BlockedCard({ id = 'blocked', hint, load, labelOf, unblock }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);

  const reload = () => load().then((r) => { setRows(r || []); setErr(null); }).catch((e) => setErr(e?.message || 'Could not load'));
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doUnblock = async (row, key) => {
    setBusy(key);
    try { await unblock(row); await reload(); }
    catch (e) { setErr(e?.message || 'Could not unblock'); }
    finally { setBusy(null); }
  };

  return (
    <div id={id} className="card" style={{ padding: 22, scrollMarginTop: 80 }}>
      <div className="metric-label" style={{ marginBottom: 8 }}>Blocked</div>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
        {hint || 'Blocked contacts cannot message you and you cannot message them. You can unblock any time.'}
      </p>
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)', marginBottom: 8 }}>{err}</div>}
      {rows === null ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>No one is blocked.</div>
      ) : rows.map((row, i) => {
        const key = row.clientId || row.workspaceId || String(i);
        return (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labelOf(row)}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                Blocked {row.createdAt ? new Date(row.createdAt).toLocaleDateString() : ''}{row.reason ? ` · ${row.reason}` : ''}
              </div>
            </div>
            <button type="button" className="btn btn-outline" disabled={busy === key} onClick={() => doUnblock(row, key)} style={{ whiteSpace: 'nowrap' }}>
              {busy === key ? '…' : 'Unblock'}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// "Reports" settings card: the person's own reports with status.
export function ReportsCard({ id = 'reports', load, subjectOf }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    load().then((r) => { if (live) { setRows(r || []); setErr(null); } })
      .catch((e) => { if (live) setErr(e?.message || 'Could not load'); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div id={id} className="card" style={{ padding: 22, scrollMarginTop: 80 }}>
      <div className="metric-label" style={{ marginBottom: 8 }}>Reports</div>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
        Things you have reported to our team. We review every report within 24 hours.
      </p>
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)', marginBottom: 8 }}>{err}</div>}
      {rows === null ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>You haven&apos;t reported anything.</div>
      ) : rows.map((r) => (
        <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>
              {r.reasonLabel || r.reason}
              <span style={{ fontWeight: 400, color: 'var(--muted)' }}> · {targetLabel(r.targetType)}{subjectOf?.(r) ? ` · ${subjectOf(r)}` : ''}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              {new Date(r.createdAt).toLocaleDateString()}{r.details ? ` · ${r.details.length > 80 ? r.details.slice(0, 80) + '…' : r.details}` : ''}
            </div>
          </div>
          <StatusBadge status={r.status}/>
        </div>
      ))}
    </div>
  );
}

// Convenience fetchers shared by the two sides.
export const ownerModeration = {
  loadBlocks:  () => api.get('/messages/blocks').then((r) => r.blocks || []),
  loadReports: () => api.get('/messages/reports').then((r) => r.reports || []),
  block:       (clientId, reason) => api.post('/messages/blocks', { clientId, reason }),
  unblock:     (clientId) => api.del('/messages/blocks', { clientId }),
  report:      (body) => api.post('/messages/reports', body),
};
export const clientModeration = {
  loadBlocks:  () => api.get('/me/blocks').then((r) => r.blocks || []),
  loadReports: () => api.get('/me/reports').then((r) => r.reports || []),
  block:       (workspaceId) => api.post('/me/blocks', { workspaceId }),
  unblock:     (workspaceId) => api.del('/me/blocks', { workspaceId }),
  report:      (body) => api.post('/me/reports', body),
};
