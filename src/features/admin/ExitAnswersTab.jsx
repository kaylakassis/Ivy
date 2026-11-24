// Admin > Exit answers: why owners left. How many were asked and answered,
// each reason's share, and the answers themselves. Data: GET
// /api/admin/exit-answers (api/_lib/exitInterview.js).
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

const WINDOWS = [30, 90, 365];
const SOURCE = { cancel: 'Cancelled', trial: 'Trial ran out', delete: 'Deleted account' };
const GROUPS = [['all', 'Everyone'], ['cancel', 'Cancelled a plan'], ['trial', 'Trial ran out'], ['delete', 'Deleted account']];
const CHANNEL = { app: 'in the app', email: 'from the email' };
const PLAN = { stripe: 'paid by card', apple: 'paid through Apple', trial: 'on a trial' };

export default function ExitAnswersTab() {
  const [days, setDays] = useState(90);
  const [source, setSource] = useState('all');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    setData(null); setErr(null);
    api.get(`/admin/exit-answers?days=${days}&source=${source}`)
      .then((r) => { if (live) setData(r); })
      .catch((e) => { if (live) setErr(e.message || 'Could not load'); });
    return () => { live = false; };
  }, [days, source]);

  return (
    <div data-exit-answers style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Exit answers</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5, maxWidth: 640 }}>
            What owners said when they cancelled, let a free trial run out, or deleted their account. Asked in the app, in the emails, and on the delete screen.
          </div>
        </div>
        <div className="tab-row" role="tablist" aria-label="Period">
          {WINDOWS.map((d) => (
            <button key={d} type="button" role="tab" aria-selected={days === d} onClick={() => setDays(d)} className="seg-btn" style={{
              padding: '6px 12px', borderRadius: 8, border: 0, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
              background: days === d ? 'var(--surface)' : 'transparent', color: days === d ? 'var(--fg)' : 'var(--muted)',
              boxShadow: days === d ? 'var(--shadow-sm)' : 'none',
            }}>{d === 365 ? 'Last year' : `Last ${d} days`}</button>
          ))}
        </div>
      </div>

      <div className="tab-row" role="tablist" aria-label="Who answered" style={{ alignSelf: 'flex-start' }}>
        {GROUPS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={source === id} data-exit-group={id} onClick={() => setSource(id)} className="seg-btn" style={{
            padding: '6px 12px', borderRadius: 8, border: 0, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            background: source === id ? 'var(--surface)' : 'transparent', color: source === id ? 'var(--fg)' : 'var(--muted)',
            boxShadow: source === id ? 'var(--shadow-sm)' : 'none', whiteSpace: 'nowrap',
          }}>{label}{id !== 'all' && data?.bySource ? ` (${data.bySource[id] || 0})` : ''}</button>
        ))}
      </div>

      {err && <div className="card" style={{ padding: 16, color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
      {!data && !err && <div className="card" style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}

      {data && data.asked === 0 && (
        <div className="card" style={{ padding: 18, fontSize: 13.5, lineHeight: 1.55 }}>
          <strong>No answers yet{source === 'all' ? '' : ' in this group'}.</strong> Owners are asked from the day this was added. Answers appear here as people leave.
        </div>
      )}

      {data && data.asked > 0 && (
        <>
          <div className="card" style={{ padding: 16, fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            <strong style={{ fontSize: 22, color: 'var(--fg)' }}>{data.answered}</strong> answered,{' '}
            <strong style={{ color: 'var(--fg)' }}>{data.skipped}</strong> chose "Not now".
          </div>
          {data.answered > 0 && (
            <div className="card" style={{ padding: 16 }}>
              <div className="metric-label" style={{ marginBottom: 4 }}>Reasons</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>People can pick more than one, so these add up to more than 100%.</div>
              {data.reasons.filter((r) => r.count > 0).map((r) => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: 13 }}>
                  <div style={{ width: 230, flexShrink: 0 }}>{r.label}</div>
                  <div aria-hidden style={{ flex: 1, height: 8, borderRadius: 99, background: 'var(--border)', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.max(2, r.pct)}%`, height: '100%', background: 'var(--accent)' }}/>
                  </div>
                  <div style={{ width: 84, flexShrink: 0, textAlign: 'right', color: 'var(--fg-2)' }}>{r.count} · {r.pct}%</div>
                </div>
              ))}
            </div>
          )}
          <div className="card" style={{ padding: 16 }}>
            <div className="metric-label" style={{ marginBottom: 10 }}>Answers, newest first</div>
            {data.answers.map((a) => (
              <div key={a.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {new Date(a.at).toLocaleDateString([], { dateStyle: 'medium' })} · {SOURCE[a.source] || a.source}, {CHANNEL[a.channel] || a.channel}
                  {a.business ? ` · ${a.business}` : ' · account since deleted'}
                  {a.monthsWithIvy != null ? ` · with Ivy ${a.monthsWithIvy === 0 ? 'under a month' : `${a.monthsWithIvy} ${a.monthsWithIvy === 1 ? 'month' : 'months'}`}` : ''}
                  {a.planSource && PLAN[a.planSource] ? ` · ${PLAN[a.planSource]}` : ''}
                </div>
                {a.reasons.length > 0 && <div style={{ fontSize: 13.5, fontWeight: 600, marginTop: 3 }}>{a.reasons.join(' · ')}</div>}
                {a.comment && <div style={{ fontSize: 13.5, color: 'var(--fg-2)', marginTop: 3, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{a.comment}</div>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
