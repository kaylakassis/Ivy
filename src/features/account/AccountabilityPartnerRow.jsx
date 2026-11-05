// "Accountability partner": one row in Account > Notifications, in the same
// list as the other push switches (and the same screen in the iPhone app).
// On by default. Turning it off asks first, because it is there to help:
// "Keep it on" is the main button. While it is on, the finer choices sit
// right under the row: how often, which kinds of reminders, and email.
// Settings live on the server (/api/me/accountability) so they follow the
// owner to every device.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';

export const PARTNER_WARNING = 'Your accountability partner is here to help you stay on top of things: unanswered messages, unsigned documents, quiet clients. Turn it off anyway?';

function Toggle({ checked, disabled, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={onChange} disabled={disabled}
      style={{
        flexShrink: 0, marginTop: 1, width: 36, height: 22, borderRadius: 999,
        background: checked ? 'var(--accent)' : 'var(--border-strong)',
        border: 0, padding: 2, cursor: disabled ? 'wait' : 'pointer', opacity: disabled ? 0.6 : 1,
      }}>
      <span className="switch-thumb" style={{
        display: 'block', width: 18, height: 18, borderRadius: 999, background: '#fff',
        transform: checked ? 'translateX(14px)' : 'translateX(0)', boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
      }}/>
    </button>
  );
}

function TurnOffDialog({ onKeep, onTurnOff, busy }) {
  const keepRef = useRef(null);
  useEffect(() => {
    keepRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onKeep(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKeep]);
  return (
    <div role="presentation" onClick={onKeep} style={{
      position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div role="dialog" aria-modal="true" aria-labelledby="partner-off-title" className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 420, padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div id="partner-off-title" style={{ fontSize: 17, fontWeight: 650 }}>Turn off your accountability partner?</div>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: 'var(--fg-2)' }}>{PARTNER_WARNING}</p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onTurnOff} disabled={busy}
            style={{ color: 'var(--muted)' }}>
            {busy ? 'Turning off…' : 'Turn off'}
          </button>
          <button type="button" ref={keepRef} className="btn btn-primary" onClick={onKeep} disabled={busy}>
            Keep it on
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AccountabilityPartnerRow() {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/me/accountability?view=settings')
      .then((r) => { if (live) setS(r); })
      .catch(() => { if (live) setS(null); });
    return () => { live = false; };
  }, []);

  const save = async (patch) => {
    const prev = s;
    setS((x) => ({ ...x, ...patch, kinds: patch.kinds ? { ...x.kinds, ...patch.kinds } : x.kinds }));
    setBusy(true); setErr(null);
    try {
      const r = await api.patch('/me/accountability', patch);
      setS((x) => ({ ...x, ...r }));
      return true;
    } catch (e) {
      setS(prev);
      setErr(e.message || 'Could not save');
      return false;
    } finally { setBusy(false); }
  };

  if (!s) return null;
  const on = s.enabled !== false;
  const onToggle = () => { if (on) setAsking(true); else save({ enabled: true }); };

  return (
    <div data-testid="partner-row" style={{
      padding: '10px 12px', borderRadius: 10,
      background: 'var(--surface-2)', border: `1px solid ${on ? 'color-mix(in srgb, var(--accent) 35%, var(--border))' : 'var(--border)'}`,
    }}>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: busy ? 'wait' : 'pointer' }}>
        <Toggle checked={on} disabled={busy} onChange={onToggle} label="Accountability partner"/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Accountability partner</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
            Ivy checks in at most once a day, between 9am and 7pm, with what needs you: unanswered messages, documents to send or get signed, unpaid invoices, quiet clients. And a friendly check-in if you have been away for 3 days.
          </div>
        </div>
      </label>

      {err && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>{err}</div>}

      {on && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--border)', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>How often</div>
            <div role="radiogroup" aria-label="How often" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(s.frequencyOrder || []).map((f) => {
                const sel = s.frequency === f;
                return (
                  <button key={f} type="button" role="radio" aria-checked={sel} disabled={busy}
                    onClick={() => !sel && save({ frequency: f })}
                    className={sel ? 'btn btn-primary' : 'btn btn-outline'}
                    style={{ padding: '6px 11px', fontSize: 12.5 }}>
                    {s.frequencyLabels?.[f] || f}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>Remind me about</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(s.kindOrder || []).map((k) => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, cursor: busy ? 'wait' : 'pointer' }}>
                  <input type="checkbox" checked={s.kinds?.[k] !== false} disabled={busy}
                    onChange={(e) => save({ kinds: { [k]: e.target.checked } })}/>
                  {s.kindLabels?.[k] || k}
                </label>
              ))}
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: busy ? 'wait' : 'pointer' }}>
            <Toggle checked={s.emailEnabled !== false} disabled={busy} label="Also email me"
              onChange={() => save({ emailEnabled: !(s.emailEnabled !== false) })}/>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Also email me</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
                The same note by email, so it's waiting in your inbox too.
              </div>
            </div>
          </label>
        </div>
      )}

      {asking && (
        <TurnOffDialog busy={busy}
          onKeep={() => setAsking(false)}
          onTurnOff={async () => { const okd = await save({ enabled: false }); if (okd) setAsking(false); }}/>
      )}
    </div>
  );
}
