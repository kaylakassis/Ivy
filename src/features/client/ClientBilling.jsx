// /me/billing — saved cards + active memberships across every
// business the user is a client of. Two stacked sections; either
// or both can be empty depending on which businesses use card-on-
// file or membership flows.
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelRowList } from '../../components/Skeleton.jsx';
import { api } from '../../lib/api.js';

function fmtMoney(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function intervalLabel(i) {
  return ({ week: '/ week', month: '/ month', quarter: '/ 3 months', year: '/ year' })[i] || '/ month';
}

export default function ClientBilling() {
  const [params, setParams] = useSearchParams();
  const [cards, setCards] = useState(null);
  const [memberships, setMemberships] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Toast for "save=ok" / "save=cancel" return URLs from Stripe Checkout.
  const saveStatus = params.get('save');
  useEffect(() => {
    if (saveStatus) {
      const t = setTimeout(() => {
        const next = new URLSearchParams(params);
        next.delete('save');
        setParams(next, { replace: true });
      }, 4000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [saveStatus, params, setParams]);

  useEffect(() => {
    let live = true;
    setError(null);
    Promise.all([
      api.get('/me/payment-methods'),
      api.get('/me/memberships').catch(() => ({ memberships: [] })),
    ])
      .then(([pm, ms]) => {
        if (!live) return;
        setCards(pm.cards || []);
        setMemberships(ms.memberships || []);
      })
      .catch((e) => live && setError(e));
    return () => { live = false; };
  }, [reloadKey]);

  const saveCard = async (clientId) => {
    setBusy(true);
    try {
      const r = await api.post('/me/payment-methods', { clientId });
      window.location.href = r.url;
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const removeCard = async (clientId) => {
    if (!window.confirm('Remove this card?')) return;
    setBusy(true);
    try {
      await api.del('/me/payment-methods/' + encodeURIComponent(clientId));
      setReloadKey((n) => n + 1);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const cancelMembership = async (id) => {
    if (!window.confirm('Cancel this membership? Access continues until the end of the current period.')) return;
    setBusy(true);
    try {
      await api.del('/me/memberships/' + encodeURIComponent(id));
      setReloadKey((n) => n + 1);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (cards === null && !error) {
    return (
      <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <SkelRowList rows={3}/>
      </div>
    );
  }

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <h2 style={{
          fontFamily: 'var(--font-display)', fontWeight: 500,
          fontSize: 'clamp(26px, 4vw, 32px)',
          letterSpacing: '-0.03em', margin: '0 0 6px', lineHeight: 1.05,
        }}>Billing</h2>
        <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
          Saved cards and active memberships across every business you work with.
        </p>
      </div>

      {saveStatus === 'ok' && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'color-mix(in srgb, var(--ok) 8%, var(--surface-2))',
          border: '1px solid var(--ok)',
          fontSize: 13, color: 'var(--ok)',
        }}>Card saved. You're all set.</div>
      )}
      {saveStatus === 'cancel' && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          fontSize: 13, color: 'var(--muted)',
        }}>Card setup was cancelled. Try again any time.</div>
      )}
      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
          color: 'var(--danger)', fontSize: 13,
        }}>{error.message || 'Something went wrong.'}</div>
      )}

      <Section title="Cards on file"
        hint="Used by businesses to charge late-cancel/no-show fees, tips, and (when allowed) membership renewals.">
        {cards && cards.length === 0 ? (
          <div className="card" style={{ padding: 32 }}>
            <EmptyNote icon="Lock"
              title="No businesses linked yet"
              hint="Once you book with a business, you can save a card on file with them here."/>
          </div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            {(cards || []).map((c, i) => (
              <div key={c.clientId} style={{
                padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14,
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                flexWrap: 'wrap',
              }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                  background: 'var(--accent-soft)', color: 'var(--accent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}><Icons.Lock size={16} sw={1.7}/></div>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{c.businessName}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                    {c.hasCard
                      ? `${capitalize(c.brand) || 'Card'} ending in ${c.last4}${c.expMonth ? ` · expires ${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}` : ''}`
                      : 'No card on file'}
                  </div>
                </div>
                {c.hasCard
                  ? (
                    <>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => saveCard(c.clientId)}
                        style={{ fontSize: 12, padding: '6px 12px' }}>
                        Replace
                      </button>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => removeCard(c.clientId)}
                        style={{ fontSize: 12, padding: '6px 12px', color: 'var(--danger)' }}>
                        Remove
                      </button>
                    </>
                  )
                  : (
                    <button className="btn btn-primary" disabled={busy} onClick={() => saveCard(c.clientId)}
                      style={{ fontSize: 12, padding: '6px 14px' }}>
                      <Icons.Plus size={11} sw={2}/> Save a card
                    </button>
                  )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Memberships"
        hint="Subscriptions you've signed up for. Cancel any time — your access continues to the end of the period you've already paid for.">
        {memberships && memberships.length === 0 ? (
          <div className="card" style={{ padding: 32 }}>
            <EmptyNote icon="Heart"
              title="No memberships yet"
              hint="Some businesses on THRYVE offer monthly memberships — they'll show up on their booking page when they do."/>
          </div>
        ) : (
          <div className="card" style={{ overflow: 'hidden' }}>
            {(memberships || []).map((m, i) => (
              <div key={m.id} style={{
                padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14,
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                flexWrap: 'wrap',
              }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                  background: m.status === 'active' ? 'var(--accent-soft)' : 'var(--surface-2)',
                  color: m.status === 'active' ? 'var(--accent)' : 'var(--muted)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}><Icons.Heart size={16} sw={1.7}/></div>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{m.membershipName}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                    {m.businessName} · {fmtMoney(m.priceCents)} {intervalLabel(m.interval)}
                    {m.status === 'past_due' && ' · Payment past due'}
                    {m.cancelAtPeriodEnd && m.currentPeriodEnd && ` · Cancels ${new Date(m.currentPeriodEnd).toLocaleDateString()}`}
                  </div>
                </div>
                {!m.cancelAtPeriodEnd && m.status !== 'cancelled' && (
                  <button className="btn btn-ghost" disabled={busy} onClick={() => cancelMembership(m.id)}
                    style={{ fontSize: 12, padding: '6px 12px', color: 'var(--danger)' }}>
                    Cancel
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ title, hint, children }) {
  return (
    <div>
      <div className="metric-label" style={{ marginBottom: 6 }}>{title}</div>
      {hint && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.5 }}>
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
