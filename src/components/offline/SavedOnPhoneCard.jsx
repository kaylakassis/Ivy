// Account > Your data (iPhone app only): what Ivy keeps on this phone for
// use without signal, and a button to clear it now.
import React, { useState } from 'react';
import { Icons } from '../Icons.jsx';
import { clearOfflineData } from '../../lib/offlineData.js';
import { useSnapshot } from '../../lib/useOffline.js';
import { snapshotSavedAt, fmtSavedAt } from '../../lib/snapshot.js';

export default function SavedOnPhoneCard() {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  useSnapshot('bookings');
  const at = snapshotSavedAt();
  const clear = async () => {
    setBusy(true);
    try { await clearOfflineData(); setDone(true); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ padding: 22 }}>
      <div className="metric-label" style={{ marginBottom: 8 }}>Saved on this phone</div>
      <h3 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 600 }}>Works without signal</h3>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        Ivy keeps a small copy of today's and tomorrow's appointments, your client list
        (names, phone, email, address) and your last 20 conversations on this phone, so
        you can see them with no signal. It never includes payment details, documents or
        other businesses' data, and signing out clears it.
        {at && !done ? ` Last saved ${fmtSavedAt(at)}.` : ''}
      </p>
      {done ? (
        <div role="status" style={{ fontSize: 13, color: 'var(--ok)', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
          <Icons.Check size={13} sw={2.4}/> Cleared. Ivy will save a fresh copy the next time you open your schedule.
        </div>
      ) : (
        <button type="button" className="btn btn-outline" onClick={clear} disabled={busy}>
          <Icons.Trash size={14}/> {busy ? 'Clearing…' : 'Clear saved data on this phone'}
        </button>
      )}
    </div>
  );
}
