// Admin > Users > Manage: shown when a person has more than one business
// record (a sign-up race before businesses were made one per owner). Lists
// each one with what it holds, so the super-admin can remove the empty
// copy. Server rules (api/admin/users/[id]/workspaces.js): never the last
// one, never one with a live plan, and one holding real data only after an
// explicit second confirmation.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { confirmAction } from '../../lib/confirm.js';

const fmt = (d) => (d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const prettyTable = (t) => t.replace(/_/g, ' ');

export default function DuplicateBusinesses({ userId, onChanged }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [done, setDone] = useState(null);

  // Can this account be switched to a client account (someone who created
  // a business by mistake)? { eligible, dataRows, needsConfirm } or a reason.
  const [clientSwitch, setClientSwitch] = useState(null);
  const load = () => api.get(`/admin/users/${userId}/workspaces`)
    .then((r) => { setList(r.workspaces || []); setClientSwitch(r.clientSwitch || null); })
    .catch((e) => setErr(e.message || 'Could not load'));

  const makeClient = async () => {
    const n = clientSwitch?.dataRows || 0;
    if (!(await confirmAction({
      title: 'Make this a client account?',
      body: n > 0
        ? `Their business holds ${n} record${n === 1 ? '' : 's'} (clients, bookings, services and so on). Those are deleted with it, and this cannot be undone. Only do this if they never meant to run a business on Ivy.`
        : 'Their unused business set-up is removed and Ivy opens the client view for them next time. They can start a business again later.',
      confirmLabel: n > 0 ? 'Delete the records and switch' : 'Switch to client account',
      danger: n > 0,
    }))) return;
    setBusy('client'); setErr(null); setDone(null);
    try {
      await api.post(`/admin/users/${userId}/workspaces`, { makeClientAccount: true, allowData: n > 0 });
      setList([]); setClientSwitch(null);
      setDone('Switched. This is now a client account.');
      onChanged && onChanged();
    } catch (e) {
      setErr(e.message || 'Could not switch');
    } finally { setBusy(null); }
  };
  useEffect(() => { load(); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (w) => {
    if (!(await confirmAction({ title: w.dataRows > 0 ? 'Remove this business and everything in it?' : 'Remove this empty business record?', body: w.dataRows > 0 ? `It holds ${w.dataRows} records. Removing it deletes them for good.` : 'This cannot be undone.', confirmLabel: 'Remove', danger: true }))) return;
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
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, color: 'var(--fg-2)' }}>
          {done || (list.length === 0 ? 'No business. This is a client or helper account.' : 'One business. Nothing to resolve.')}
        </div>
        {list.length === 1 && clientSwitch && (
          <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <strong style={{ fontSize: 13.5 }}>Signed up as a business by mistake?</strong>
            {clientSwitch.eligible ? (
              <>
                <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                  If this person is really a client of a business, switch them to a client account. Their business set-up is removed
                  {clientSwitch.dataRows > 0 ? `, along with the ${clientSwitch.dataRows} record${clientSwitch.dataRows === 1 ? '' : 's'} in it` : ' (it holds no records)'}
                  , and Ivy opens the client view for them.
                </div>
                <button className="btn btn-outline" disabled={!!busy} onClick={makeClient} style={{ alignSelf: 'flex-start', fontSize: 12.5 }}>
                  {busy === 'client' ? 'Switching…' : 'Make this a client account'}
                </button>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                Cannot be switched to a client account: {clientSwitch.message}
              </div>
            )}
            {err && <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>{err}</div>}
          </div>
        )}
      </div>
    );
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
