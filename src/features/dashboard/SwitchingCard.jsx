// "Switching from another app?" - for an owner whose book still looks new
// (server sets dashboard.switchPrompt: fewer than 3 clients, no bookings).
// Opens the import hub right here. Dismissed per device.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import ImportClientsModal from '../clients/ImportClientsModal.jsx';

const KEY = 'ivy.switchCard.dismissed';

export function dismissed() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export default function SwitchingCard({ show, onImported }) {
  const [gone, setGone] = useState(() => dismissed());
  const [open, setOpen] = useState(false);
  if ((!show || gone) && !open) return null;

  const dismiss = () => {
    setGone(true);
    try { localStorage.setItem(KEY, '1'); } catch { /* hidden for this visit anyway */ }
  };

  return (
    <>
      {show && !gone && (
        <div className="card" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 16px', flexWrap: 'wrap' }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-soft)', color: 'var(--accent)' }}>
            <Icons.Users size={16}/>
          </span>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600 }}>Switching from another app?</div>
            <div style={{ fontSize: 13, color: 'var(--fg-2)', marginTop: 3, lineHeight: 1.5 }}>
              Bring your clients and upcoming appointments over in a few minutes. Nobody gets a message unless you say so.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
            <button type="button" onClick={dismiss} className="btn btn-ghost" style={{ padding: '7px 12px', fontSize: 12.5, color: 'var(--muted)' }}>
              Dismiss
            </button>
            <button type="button" onClick={() => setOpen(true)} className="btn btn-primary" style={{ padding: '7px 14px', fontSize: 12.5 }}>
              Bring them over <Icons.Arrow size={11} sw={2}/>
            </button>
          </div>
        </div>
      )}
      {open && (
        <ImportClientsModal onClose={() => setOpen(false)} onComplete={() => onImported?.()}/>
      )}
    </>
  );
}
