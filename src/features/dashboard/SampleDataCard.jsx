// "See it with sample data" — on an empty dashboard, offers to drop in one
// sample client + booking + invoice so a new owner can see the app in use
// instead of a wall of zeros. One tap to add, one tap to remove. Backed by
// /api/onboarding/sample-data (all rows tied to a source='demo' client).
import React, { useEffect, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';

export default function SampleDataCard({ empty, onChanged }) {
  const [exists, setExists] = useState(null); // null=loading
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.get('/onboarding/sample-data')
      .then((r) => { if (live) setExists(!!r.exists); })
      .catch(() => { if (live) setExists(false); });
    return () => { live = false; };
  }, []);

  if (exists === null) return null;
  // Nothing to show once the owner has their own real data (and no demo on).
  if (!exists && !empty) return null;

  const run = async (nextExists, fn) => {
    setBusy(true);
    try {
      await fn();
      setExists(nextExists);
      onChanged?.();   // refresh the dashboard tiles/panels in place (no white-flash reload)
    } catch { /* leave state as-is */ }
    finally { setBusy(false); }
  };

  if (exists) {
    return (
      <div className="card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Icons.Spark size={16} sw={1.8} color="var(--accent)"/>
        <span style={{ flex: 1, fontSize: 13.5, color: 'var(--muted)' }}>
          Sample data is on your dashboard so you can see how everything looks.
        </span>
        <button type="button" onClick={() => run(false, () => api.del('/onboarding/sample-data'))} disabled={busy}
          className="btn btn-outline" style={{ fontSize: 13 }}>
          {busy ? 'Removing…' : 'Remove sample data'}
        </button>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{
        width: 32, height: 32, borderRadius: 9, flexShrink: 0,
        background: 'var(--accent-soft)', color: 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icons.Spark size={17} sw={1.8}/>
      </div>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600 }}>New here? See it in action</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Add a sample client, booking &amp; invoice — remove it anytime.</div>
      </div>
      <button type="button" onClick={() => run(true, () => api.post('/onboarding/sample-data'))} disabled={busy}
        className="btn btn-primary" style={{ gap: 8 }}>
        {busy ? 'Adding…' : 'Add sample data'}
      </button>
    </div>
  );
}
