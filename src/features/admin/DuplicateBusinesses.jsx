// Admin > Users > Manage: shown when a person has more than one business
// record (a sign-up race before businesses were made one per owner). Lists
// each one with what it holds, so the super-admin can remove the empty
// copy. Server rules (api/admin/users/[id]/workspaces.js): never the last
// one, never one with a live plan, and one holding real data only after an
// explicit second confirmation.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

const fmt = (d) => (d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const prettyTable = (t) => t.replace(/_/g, ' ');

export default function DuplicateBusinesses({ userId, onChanged }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [done, setDone] = useState(null);

  const load = () => api.get(`/admin/users/${userId}/workspaces`)
    .then((r) => setList(r.workspaces || []))
    .catch((e) => setErr(e.message || 'Could not load'));
  useEffect(() => { load(); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (w) => {
    const what = w.dataRows > 0
      ? `This business holds ${w.dataRows} records. Removing it deletes them for good. Remove it anyway?`
      : 'Remove this empty business record? This cannot be undone.';
    if (!window.confirm(what)) return;
    setBusy(w.id); setErr(null); setDone(null);
    try {
      const r = await api.post(`/admin/users/${userId}/workspaces`, { removeWorkspaceId: w.id, allowData: w.dataRows > 0 });
      setList(r.workspaces || []);
      setDone(r.uniqueIndex
        ? 'Removed. Every account now has one business, so a second one can no longer be created.'
        : 'Removed.');
      onChanged && onChanged();
    } catch (e) {
      setErr(e.message || 'Could not remove');
    } finally { setBusy(null); }
  };

  if (err && !list) return <div style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</div>;
  if (!list) return <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading businesses…</div>;
  if (list.length < 2) {
    return <div style={{ fontSize: 13, color: 'var(--fg-2)' }}>{done || 'One business. Nothing to resolve.'}</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
        This person has {list.length} business records, usually from signing up on a slow connection. The app uses the oldest one.
        Remove the one with nothing in it.
      </div>
      {list.map((w) => {
        const entries = Object.entries(w.counts || {}).sort((a, b) => b[1] - a[1]);
        return (
          <div key={w.id} className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 13.5 }}>{w.businessName || 'Unnamed business'}</strong>
              {w.inUse && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 99, background: 'var(--accent-soft)', color: 'var(--accent)' }}>In use</span>}
              {w.livePlan && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 99, background: 'var(--surface-2)', color: 'var(--fg-2)' }}>Has a plan</span>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Created {fmt(w.createdAt)}{w.slug ? ` · /book/${w.slug}` : ''}{w.subscriptionStatus ? ` · ${w.subscriptionStatus}` : ''}{w.onboardedAt ? ' · finished setup' : ''}
            </div>
            <div style={{ fontSize: 12.5 }}>
              {w.dataRows > 0
                ? <>Holds <strong>{w.dataRows}</strong> records: {entries.filter(([t]) => !['calendar_settings', 'workspace_profile', 'finance_settings', 'websites'].includes(t)).slice(0, 8).map(([t, n]) => `${prettyTable(t)} ${n}`).join(', ')}</>
                : <span style={{ color: 'var(--ok, var(--accent))' }}>Empty (only the automatic setup records)</span>}
            </div>
            <div>
              <button className="btn btn-outline" disabled={!!busy || w.livePlan}
                title={w.livePlan ? 'Cancel or move the plan first' : undefined}
                onClick={() => remove(w)}
                style={{ fontSize: 12, padding: '5px 10px', color: 'var(--danger)' }}>
                {busy === w.id ? 'Removing…' : 'Remove this business'}
              </button>
            </div>
          </div>
        );
      })}
      {err && <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>{err}</div>}
      {done && <div style={{ color: 'var(--accent)', fontSize: 12.5 }}>{done}</div>}
    </div>
  );
}
