// Admin > First week: where new accounts stop.
//
// For businesses that signed up in the chosen window: how many reached each
// screen in their first seven days, how many days they came back, and the
// last screen seen by the ones who then went quiet. Counts only; no account
// is named. Data: GET /api/admin/first-week (api/_lib/screenVisits.js).
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

const WINDOWS = [30, 60, 90];

export default function FirstWeekTab() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    setData(null); setErr(null);
    api.get(`/admin/first-week?days=${days}`)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setErr(e.message || 'Could not load'); });
    return () => { live = false; };
  }, [days]);

  const since = data?.countingSince ? new Date(data.countingSince).toLocaleDateString([], { dateStyle: 'medium' }) : null;
  const active = data?.daysActive;
  return (
    <div data-first-week style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>First week</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5, maxWidth: 640 }}>
            Which screens new businesses open in their first seven days, and where the ones who go quiet were last seen. Counts only.
          </div>
        </div>
        <div className="tab-row" role="tablist" aria-label="Signed up in the last">
          {WINDOWS.map((d) => (
            <button key={d} type="button" role="tab" aria-selected={days === d} onClick={() => setDays(d)} className="seg-btn" style={{
              padding: '6px 12px', borderRadius: 8, border: 0, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
              background: days === d ? 'var(--surface)' : 'transparent', color: days === d ? 'var(--fg)' : 'var(--muted)',
              boxShadow: days === d ? 'var(--shadow-sm)' : 'none',
            }}>Last {d} days</button>
          ))}
        </div>
      </div>

      {err && <div className="card" style={{ padding: 16, color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
      {!data && !err && <div className="card" style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}

      {data && !data.countingSince && (
        <div className="card" style={{ padding: 18, fontSize: 13.5, lineHeight: 1.55 }}>
          <strong>Nothing counted yet.</strong> Screens started being counted when this view was added. Numbers appear as businesses use the app, and a new business shows up here from the day it signs up.
        </div>
      )}

      {data && data.countingSince && (
        <>
          <div className="card" style={{ padding: 16, fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            <strong style={{ fontSize: 22, color: 'var(--fg)' }}>{data.cohort}</strong>{' '}
            {data.cohort === 1 ? 'business' : 'businesses'} signed up in the last {data.days} days (since counting began on {since}).
            Test, complimentary and operator accounts are left out.
          </div>

          {data.cohort > 0 && active && (
            <div className="card" style={{ padding: 16 }}>
              <div className="metric-label" style={{ marginBottom: 10 }}>Days they opened the app in their first week</div>
              <div className="grid-auto">
                <Tile label="Never opened it" n={active.never} of={data.cohort} tone="bad"/>
                <Tile label="One day only" n={active.oneDay} of={data.cohort} tone="warn"/>
                <Tile label="Two or three days" n={active.twoToThree} of={data.cohort}/>
                <Tile label="Four days or more" n={active.fourOrMore} of={data.cohort} tone="ok"/>
              </div>
            </div>
          )}

          {data.cohort > 0 && (
            <div className="card" style={{ padding: 16 }}>
              <div className="metric-label" style={{ marginBottom: 10 }}>Screens reached in the first seven days</div>
              {data.screens.length === 0
                ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>None of them has opened a screen yet.</div>
                : data.screens.map((s) => <Bar key={s.screen} label={s.label} n={s.accounts} pct={s.pct}/>)}
            </div>
          )}

          <div className="card" style={{ padding: 16 }}>
            <div className="metric-label" style={{ marginBottom: 4 }}>Where the quiet ones stopped</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>
              Businesses at least a week old that have opened nothing for a week, by the last screen they saw.
            </div>
            {data.wentQuiet.accounts === 0
              ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>None so far.</div>
              : data.wentQuiet.lastScreens.map((s) => (
                <Bar key={s.screen} label={s.label} n={s.accounts} pct={Math.round((s.accounts / data.wentQuiet.accounts) * 100)}/>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, n, of, tone }) {
  const color = tone === 'bad' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : tone === 'ok' ? 'var(--ok)' : 'var(--fg)';
  return (
    <div style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 650, color, marginTop: 2 }}>{n}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{of ? Math.round((n / of) * 100) : 0}% of {of}</div>
    </div>
  );
}

function Bar({ label, n, pct }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: 13 }}>
      <div style={{ width: 150, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
      <div aria-hidden style={{ flex: 1, height: 8, borderRadius: 99, background: 'var(--border)', overflow: 'hidden' }}>
        <div style={{ width: `${Math.max(2, pct)}%`, height: '100%', background: 'var(--accent)' }}/>
      </div>
      <div style={{ width: 84, flexShrink: 0, textAlign: 'right', color: 'var(--fg-2)' }}>{n} · {pct}%</div>
    </div>
  );
}
