// Admin → Accountability partner: is it working? Reads
// GET /api/admin/accountability-partner (super-admin only, counts only:
// no names, emails or message text). Every number says what it means; a
// rate only shows once there are enough cases behind it, and anything not
// collected yet says "Collecting data since <date>" instead of a number.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

const fmtN = (n) => Number(n || 0).toLocaleString();
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const fmtDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const pctText = (p) => (p == null ? null : `${p}%`);

// Series colours for the four kinds of message: a validated categorical
// order (blue, orange, aqua, yellow), stepped separately for the dark theme.
const VIZ_CSS = `
.pv-root { --pv-s1:#2a78d6; --pv-s2:#eb6834; --pv-s3:#1baf7a; --pv-s4:#eda100; }
.dir-bold .pv-root { --pv-s1:#3987e5; --pv-s2:#d95926; --pv-s3:#199e70; --pv-s4:#c98500; }
.pv-table { width:100%; border-collapse:collapse; font-size:12.5px; }
.pv-table th { text-align:left; font-weight:500; color:var(--muted); font-size:11.5px; padding:6px 8px; border-bottom:1px solid var(--border); }
.pv-table td { padding:7px 8px; border-bottom:1px solid var(--border); vertical-align:top; }
.pv-table td.n, .pv-table th.n { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.pv-table td:first-child { min-width:150px; }
.pv-scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
`;
const KIND_COLOR = { daily: 'var(--pv-s1)', weekly: 'var(--pv-s2)', away3: 'var(--pv-s3)', away7: 'var(--pv-s4)' };

function Card({ title, sub, children }) {
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>{sub}</div>}
      </div>
      {children}
    </div>
  );
}

function Tile({ label, value, hint, collecting }) {
  return (
    <div style={{ padding: 14, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', minWidth: 0 }}>
      <div className="metric-label" style={{ marginBottom: 6 }}>{label}</div>
      {collecting ? (
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.45 }}>{collecting}</div>
      ) : (
        <div className="metric-value" style={{ fontSize: 24, fontWeight: 600 }}>{value}</div>
      )}
      {hint && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.45 }}>{hint}</div>}
    </div>
  );
}

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 };

function collectingText(since, have, need) {
  if (!since) return 'Collecting data from the next partner message.';
  return `Collecting data since ${fmtDate(since)} (${fmtN(have)} of ${fmtN(need)} needed).`;
}

// 30 days of sends, stacked by kind. Days before tracking began are not
// drawn (they were not collected, not zero).
function SendsChart({ days, kinds }) {
  const [hover, setHover] = useState(null);
  const total = (d) => kinds.reduce((a, k) => a + (d[k.id] || 0), 0);
  const max = Math.max(1, ...days.map(total));
  const H = 140;
  const shown = hover != null ? days[hover] : null;
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 10 }} aria-label="Legend">
        {kinds.map((k) => (
          <span key={k.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-2)' }}>
            <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: KIND_COLOR[k.id] }}/>
            {k.label}
          </span>
        ))}
      </div>
      <div style={{ position: 'relative' }}>
        <div role="img" aria-label="Partner messages sent per day, last 30 days"
          style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: H, borderBottom: '1px solid var(--border-strong)' }}
          onMouseLeave={() => setHover(null)}>
          {days.map((d, i) => {
            return (
              <div key={d.day} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}
                style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column-reverse', gap: 2, cursor: 'default',
                  background: hover === i ? 'var(--surface-2)' : 'transparent' }}>
                {d.collected && kinds.map((k, ki) => {
                  const v = d[k.id] || 0;
                  if (!v) return null;
                  const top = kinds.slice(ki + 1).every((x) => !(d[x.id] > 0));
                  return <div key={k.id} style={{ height: `${(v / max) * (H - 4)}px`, background: KIND_COLOR[k.id], borderRadius: top ? '4px 4px 0 0' : 0, flexShrink: 0 }}/>;
                })}
                {!d.collected && <div style={{ height: 2, background: 'var(--border)' }}/>}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
          <span>{fmtDay(days[0].day)}</span><span>max {fmtN(max)} a day</span><span>{fmtDay(days[days.length - 1].day)}</span>
        </div>
        {shown && (
          <div role="status" style={{ marginTop: 8, fontSize: 12, padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
            <strong>{fmtDay(shown.day)}</strong>{' '}
            {shown.collected
              ? <>{fmtN(total(shown))} sent{total(shown) ? `: ${kinds.filter((k) => shown[k.id]).map((k) => `${k.label} ${fmtN(shown[k.id])}`).join(', ')}` : ''}</>
              : 'not collected (before tracking began)'}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AccountabilityPartnerTab() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    api.get('/admin/accountability-partner')
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setErr(e.message || 'Could not load'); });
    return () => { live = false; };
  }, []);

  if (err) return <div className="card" style={{ padding: 16, color: 'var(--danger)', fontSize: 13 }}>{err}</div>;
  if (!data) return <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>;

  const { reach, sends, helped, turnOffs, trackingSince, minSample } = data;
  const freqTotal = Math.max(1, reach.on);
  const freqRows = [['daily', 'Daily digest'], ['important', 'Only important things'], ['weekly', 'Weekly']];
  const op = helped.opened;
  const cl = helped.cleared;
  const w = turnOffs.warning;

  return (
    <div className="pv-root" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{VIZ_CSS}</style>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.55 }}>
        Counts only: no names, emails or message text. Test, beta, sponsored and admin accounts are left out.
        {trackingSince
          ? ` Messages, opens, "Not today" taps and items cleared are counted since ${fmtDate(trackingSince)}.`
          : ' Messages, opens, "Not today" taps and items cleared are counted from the next partner message on.'}
      </div>

      <Card title="Who has it" sub="Owners the partner can write to: onboarded, on a plan or trial. The switches are each owner's own settings right now.">
        <div style={grid}>
          <Tile label="Owners it can reach" value={fmtN(reach.eligible)}/>
          <Tile label="Partner on" value={fmtN(reach.on)}
            hint={reach.eligible ? `${Math.round((reach.on / reach.eligible) * 1000) / 10}% of owners` : null}/>
          <Tile label="Partner off" value={fmtN(reach.off)} hint={reach.offPct != null ? `${reach.offPct}% turned it off` : null}/>
          <Tile label="Also by email" value={fmtN(reach.emailOn)} hint={`${fmtN(reach.emailOff)} with the partner on chose no email`}/>
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>How often (owners with it on)</div>
          {freqRows.map(([id, label]) => {
            const n = reach.frequency[id] || 0;
            return (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, marginBottom: 6 }}>
                <span style={{ width: 150, flexShrink: 0 }}>{label}</span>
                <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden', minWidth: 40 }}>
                  <div style={{ width: `${(n / freqTotal) * 100}%`, height: '100%', background: 'var(--pv-s1)', borderRadius: 4 }}/>
                </div>
                <span style={{ width: 70, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtN(n)}</span>
              </div>
            );
          })}
        </div>
        <div style={grid}>
          <Tile label={'"Not today", last 7 days'} value={fmtN(reach.snoozes.last7.taps)} hint={`by ${fmtN(reach.snoozes.last7.owners)} owners`}/>
          <Tile label={'"Not today", last 30 days'} value={fmtN(reach.snoozes.last30.taps)} hint={`by ${fmtN(reach.snoozes.last30.owners)} owners`}/>
        </div>
      </Card>

      <Card title="Messages sent" sub="One message a day at most per owner. Last 30 days, by kind. Push = reached at least one phone or browser; the in-app bell always gets a copy.">
        <SendsChart days={sends.days} kinds={sends.kinds}/>
        <div style={grid}>
          <Tile label="Sent (30 days)" value={fmtN(sends.last30.sent)}/>
          <Tile label="Push delivered" value={fmtN(sends.last30.pushReached)} hint="reached a device"/>
          <Tile label="Email sent" value={fmtN(sends.last30.emailed)} hint={`${fmtN(sends.last30.both)} got both`}/>
          <Tile label="Bell only" value={fmtN(sends.last30.bellOnly)} hint="no device and no email"/>
        </div>
      </Card>

      <Card title="Did it help?" sub={`Only messages whose 24 hours are over count. A percentage shows once ${minSample} cases are behind it.`}>
        <div style={grid}>
          <Tile label="Used the app within 24 hours"
            value={pctText(op.openedPct)}
            collecting={op.openedPct == null ? collectingText(trackingSince, op.messages, minSample) : null}
            hint={`${fmtN(op.opened)} of ${fmtN(op.messages)} messages. Any visit after the message, so not all of it is the message's doing.`}/>
          <Tile label="Opened from the message itself"
            value={pctText(op.clickedPct)}
            collecting={op.clickedPct == null ? collectingText(trackingSince, op.messages, minSample) : null}
            hint={`${fmtN(op.clicked)} of ${fmtN(op.messages)} tapped its notification or email link within 24 hours (${fmtN(op.clickedFromEmail)} from email). Older iPhone app versions do not report taps.`}/>
          <Tile label={`Items cleared within ${cl.windowHours} hours`}
            value={pctText(cl.clearedPct)}
            collecting={cl.clearedPct == null ? collectingText(trackingSince, cl.mentioned, minSample) : null}
            hint={`${fmtN(cl.cleared)} of ${fmtN(cl.mentioned)} things a message named; ${fmtN(cl.stillOpen)} still inside their ${cl.windowHours} hours. Checked about every 2 hours, so this can read a little low, never high.`}/>
        </div>
        <div className="pv-scroll">
          <table className="pv-table">
            <thead><tr><th>Kind of message</th><th className="n">Messages</th><th className="n">Used the app in 24 h</th></tr></thead>
            <tbody>
              {op.byKind.map((k) => (
                <tr key={k.id}>
                  <td><span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: KIND_COLOR[k.id], marginRight: 6 }}/>{k.label}</td>
                  <td className="n">{fmtN(k.messages)}</td>
                  <td className="n">{k.openedPct != null ? `${k.openedPct}%` : (k.messages ? `${fmtN(k.opened)} of ${fmtN(k.messages)}` : '-')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pv-scroll">
          <table className="pv-table">
            <thead><tr><th>What the message named</th><th className="n">Named</th><th className="n">Cleared in {cl.windowHours} h</th><th className="n">Still waiting</th></tr></thead>
            <tbody>
              {cl.bySignal.length === 0 && (
                <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>{collectingText(trackingSince, 0, minSample)}</td></tr>
              )}
              {cl.bySignal.map((s) => (
                <tr key={s.key}>
                  <td>{s.label}<div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Cleared means: {s.meaning.charAt(0).toLowerCase() + s.meaning.slice(1)}.</div></td>
                  <td className="n">{fmtN(s.mentioned)}</td>
                  <td className="n">{s.clearedPct != null ? `${s.clearedPct}%` : `${fmtN(s.cleared)} of ${fmtN(s.mentioned)}`}</td>
                  <td className="n">{fmtN(s.stillOpen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Turn-offs" sub="Who switched the partner off, which way, and how long after signing up. The settings screen always shows the warning first.">
        <div style={grid}>
          <Tile label="Saw the warning and kept it on"
            value={pctText(w.keptPct)}
            collecting={w.keptPct == null ? collectingText(w.countedSince, w.keptOn + w.turnedOff, minSample) : null}
            hint={`${fmtN(w.keptOn)} kept it on, ${fmtN(w.turnedOff)} turned it off anyway${w.countedSince ? ` since ${fmtDate(w.countedSince)}` : ''}.`}/>
          <Tile label="Turned off, all time" value={fmtN(turnOffs.total)}
            hint={turnOffs.medianDaysAfterSignup != null ? `Typically ${fmtN(turnOffs.medianDaysAfterSignup)} days after sign-up` : null}/>
        </div>
        <div className="pv-scroll">
          <table className="pv-table">
            <thead>
              <tr>
                <th>How</th><th className="n">Total</th>
                {turnOffs.bySource[0].whenAfterSignup.map((b) => <th key={b.id} className="n">{b.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {turnOffs.bySource.map((s) => (
                <tr key={s.source}>
                  <td>{s.label}</td>
                  <td className="n">{fmtN(s.count)}</td>
                  {s.whenAfterSignup.map((b) => <td key={b.id} className="n">{fmtN(b.count)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
