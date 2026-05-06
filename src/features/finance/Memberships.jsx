// Owner-side memberships management. Each tier becomes a Stripe
// Product + recurring Price on save; cancellation archives (active
// = false) so existing subscribers keep paying until they cancel.
//
// Pricing + interval are immutable post-creation because the Stripe
// Price is also immutable — to change pricing, archive + clone.
import React, { useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { api } from '../../lib/api.js';

function fmtMoney(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function intervalLabel(i) {
  return ({ week: '/ week', month: '/ month', quarter: '/ 3 months', year: '/ year' })[i] || '/ month';
}

export default function Memberships() {
  const [tiers, setTiers] = useState(null);
  const [members, setMembers] = useState([]);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // 'new' | tier object
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const r = await api.get('/memberships');
    setTiers(r.memberships || []);
  };

  useEffect(() => {
    let live = true;
    refresh().catch((e) => live && setError(e));
    return () => { live = false; };
  }, []);

  const totalsByTier = useMemo(() => {
    const map = new Map();
    for (const m of members) {
      if (m.status !== 'active' && m.status !== 'past_due') continue;
      const list = map.get(m.membershipId) || [];
      list.push(m);
      map.set(m.membershipId, list);
    }
    return map;
  }, [members]);

  const create = async (input) => {
    setBusy(true); setError(null);
    try {
      const r = await api.post('/memberships', input);
      if (r.stripeError) {
        setError({ message: 'Saved as draft. ' + r.stripeError });
      }
      await refresh();
      setEditing(null);
    } catch (e) {
      setError(e);
    } finally { setBusy(false); }
  };
  const update = async (id, patch) => {
    setBusy(true); setError(null);
    try {
      await api.patch('/memberships/' + id, patch);
      await refresh();
      setEditing(null);
    } catch (e) {
      setError(e);
    } finally { setBusy(false); }
  };
  const archive = async (id) => {
    if (!window.confirm("Archive this tier? Existing members keep their subscriptions until they cancel.")) return;
    setBusy(true); setError(null);
    try {
      await api.del('/memberships/' + id);
      await refresh();
      setEditing(null);
    } catch (e) {
      setError(e);
    } finally { setBusy(false); }
  };

  if (tiers === null && !error) {
    return <div style={{ padding: 24, color: 'var(--muted)', fontSize: 13 }}>Loading memberships…</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '12px 16px', borderRadius: 10,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5,
      }}>
        <Icons.Heart size={14} stroke="var(--accent)"/>
        <span style={{ flex: 1, minWidth: 240 }}>
          Memberships are recurring subscriptions clients sign up for from your booking page. Each tier creates a Stripe Product + recurring Price on your connected account.
        </span>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Icons.Plus size={13}/> New tier
        </button>
      </div>

      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 13,
        }}>{error.message || 'Something went wrong.'}</div>
      )}

      {tiers && tiers.length === 0 ? (
        <div className="card" style={{ padding: 36 }}>
          <EmptyNote icon="Heart"
            title="No memberships yet"
            hint="Set up a monthly tier and clients can subscribe straight from your booking page. Stripe handles the recurring charges."/>
        </div>
      ) : (
        <div className="card table-scroll" style={{ overflow: 'auto' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '2fr 130px 130px 100px 80px 40px',
            padding: '12px 20px', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase',
            fontWeight: 600, color: 'var(--muted)', borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)',
          }}>
            <div>Name</div><div>Price</div><div>Members</div><div>Stripe</div><div>Active</div><div/>
          </div>
          {tiers.map((t, i) => (
            <div key={t.id} onClick={() => setEditing(t)}
              style={{
                display: 'grid', gridTemplateColumns: '2fr 130px 130px 100px 80px 40px',
                padding: '14px 20px', alignItems: 'center', cursor: 'pointer',
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                opacity: t.active ? 1 : 0.6,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{t.name}</div>
                {t.description && (
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {t.description}
                  </div>
                )}
              </div>
              <div className="mono-num" style={{ fontSize: 13, fontWeight: 600 }}>
                {fmtMoney(t.priceCents)}<span style={{ color: 'var(--muted)', fontWeight: 500 }}> {intervalLabel(t.interval)}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--fg-2)' }}>
                {(totalsByTier.get(t.id) || []).length} member{(totalsByTier.get(t.id) || []).length === 1 ? '' : 's'}
              </div>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
                color: t.stripeReady ? 'var(--ok)' : 'var(--warn)' }}>
                {t.stripeReady ? 'Ready' : 'Not connected'}
              </div>
              <div style={{ fontSize: 11, fontWeight: 600 }}>
                {t.active ? 'Active' : 'Archived'}
              </div>
              <Icons.Arrow size={13} stroke="var(--muted)"/>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <TierEditor
          tier={editing === 'new' ? null : editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onCreate={create}
          onUpdate={update}
          onArchive={archive}
        />
      )}
    </div>
  );
}

function TierEditor({ tier, busy, onClose, onCreate, onUpdate, onArchive }) {
  const isNew = !tier;
  const [name, setName] = useState(tier?.name || '');
  const [description, setDescription] = useState(tier?.description || '');
  const [priceDollars, setPriceDollars] = useState(tier ? (Number(tier.priceCents) / 100).toFixed(2) : '');
  const [interval, setInterval] = useState(tier?.interval || 'month');
  const [perks, setPerks] = useState((tier?.perks || []).join('\n'));
  const [active, setActive] = useState(tier ? !!tier.active : true);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Name is required'); return; }
    const cents = Math.round(Number(priceDollars) * 100);
    if (!Number.isInteger(cents) || cents < 0) { setErr('Price must be a non-negative number'); return; }
    if (isNew) {
      onCreate({
        name: name.trim(),
        description: description.trim() || null,
        priceCents: cents,
        interval,
        perks: perks.split('\n').map((p) => p.trim()).filter(Boolean),
        active,
      });
    } else {
      onUpdate(tier.id, {
        name: name.trim(),
        description: description.trim() || null,
        perks: perks.split('\n').map((p) => p.trim()).filter(Boolean),
        active,
      });
    }
  };

  return (
    <div onClick={busy ? null : onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 130,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="scroll" style={{
          width: '100%', maxWidth: 540, background: 'var(--surface)',
          borderLeft: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column',
        }}>
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="metric-label">{isNew ? 'New tier' : 'Edit tier'}</div>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Monthly Membership"
              style={{
                background: 'transparent', border: 0, outline: 'none',
                fontSize: 20, fontWeight: 600, color: 'var(--fg)', width: '100%',
                fontFamily: 'inherit',
              }}/>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!isNew && (
            <div style={{
              padding: '10px 14px', borderRadius: 10,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5,
            }}>
              Price + interval can't be edited after creation — Stripe Prices are immutable. To change pricing, archive this tier and create a new one.
            </div>
          )}

          <Field label="Description (optional)">
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="What members get and why they should join."
              style={{ ...inputS, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5 }}/>
          </Field>

          <div className="form-2col">
            <Field label="Price ($)">
              <input type="number" min="0" step="0.01"
                value={priceDollars}
                onChange={(e) => setPriceDollars(e.target.value)}
                disabled={!isNew}
                placeholder="49.00"
                style={{ ...inputS, opacity: !isNew ? 0.6 : 1 }}/>
            </Field>
            <Field label="Billed every">
              <select value={interval} onChange={(e) => setInterval(e.target.value)}
                disabled={!isNew}
                style={{ ...inputS, opacity: !isNew ? 0.6 : 1 }}>
                <option value="week">Week</option>
                <option value="month">Month</option>
                <option value="quarter">3 months</option>
                <option value="year">Year</option>
              </select>
            </Field>
          </div>

          <Field label="Perks (one per line)" hint="Up to 20 lines, 200 chars each. Shown on the public booking page.">
            <textarea value={perks} onChange={(e) => setPerks(e.target.value)}
              rows={6}
              placeholder={'Unlimited bookings\n10% off products\nMember-only events'}
              style={{ ...inputS, fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5 }}/>
          </Field>

          {!isNew && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--fg-2)' }}>
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)}/>
              Active — listed on the public booking page
            </label>
          )}

          {err && (
            <div style={{
              padding: '8px 12px', borderRadius: 8,
              background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
              color: 'var(--danger)', fontSize: 12.5,
            }}>{err}</div>
          )}
        </div>

        <div style={{
          padding: '14px 24px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          {!isNew && (
            <button type="button" className="btn btn-ghost"
              style={{ color: 'var(--danger)' }}
              onClick={() => onArchive(tier.id)} disabled={busy}>
              <Icons.Trash size={13}/> Archive
            </button>
          )}
          <div style={{ flex: 1 }}/>
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : (isNew ? 'Create tier' : 'Save')}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

const inputS = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 14, outline: 'none',
};
