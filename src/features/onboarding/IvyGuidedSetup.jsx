// "Let Ivy set me up" — the guided first run for solo service businesses (any
// industry). Ivy asks 3 things,
// then DOES the setup by calling the same validated endpoints the manual
// wizard uses (PATCH /calendar, PUT /calendar/services, POST /onboarding/
// complete), narrating each step as a completed line. Ends on BookingWin with
// the live, shareable booking link.
//
// Deliberately scripted (not the LLM tool loop): Ivy has no tool to set
// availability or business name/slug yet, and a deterministic script gives a
// reliable demo. Phase 2 can route this through the real tool loop.
import React, { useState, useRef, useEffect } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import BookingWin from './BookingWin.jsx';

const slugify = (s) => String(s || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');

// Availability presets in the {weekday: [{start,end}]} minutes-from-midnight
// shape the calendar API expects (9:00–17:00 = 540–1020).
const NINE_TO_FIVE = [{ start: 540, end: 1020 }];
const PRESETS = {
  weekdays: { label: 'Weekdays, 9–5', avail: { 1: NINE_TO_FIVE, 2: NINE_TO_FIVE, 3: NINE_TO_FIVE, 4: NINE_TO_FIVE, 5: NINE_TO_FIVE } },
  everyday: { label: 'Every day, 9–5', avail: { 0: NINE_TO_FIVE, 1: NINE_TO_FIVE, 2: NINE_TO_FIVE, 3: NINE_TO_FIVE, 4: NINE_TO_FIVE, 5: NINE_TO_FIVE, 6: NINE_TO_FIVE } },
  weekends: { label: 'Weekends, 9–5', avail: { 0: NINE_TO_FIVE, 6: NINE_TO_FIVE } },
};

function IvyBubble({ children }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 12 }}>
      <div style={{
        width: 28, height: 28, borderRadius: 8, flexShrink: 0, marginTop: 2,
        background: 'var(--accent)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icons.Spark size={15} sw={2}/>
      </div>
      <div style={{
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        borderRadius: '4px 14px 14px 14px', padding: '10px 14px', fontSize: 14.5,
        lineHeight: 1.5, color: 'var(--fg)', maxWidth: 460,
      }}>{children}</div>
    </div>
  );
}

function AnswerLine({ text }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
      <div style={{
        background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 500,
        borderRadius: '14px 4px 14px 14px', padding: '8px 13px', fontSize: 14, maxWidth: 380,
      }}>{text}</div>
    </div>
  );
}

export default function IvyGuidedSetup({ user, onExit, onDone }) {
  const firstName = (user?.name || '').split(/\s+/)[0] || 'there';
  const [phase, setPhase] = useState('q1'); // q1 → q2 → q3 → working → done
  const [err, setErr] = useState(null);

  // Answers
  const [bizName, setBizName] = useState('');
  const [svc, setSvc] = useState({ name: '', durationMinutes: 60, price: '' });
  const [presetKey, setPresetKey] = useState('weekdays');

  // Setup progress (narrated Ivy lines) + result
  const [steps, setSteps] = useState([]); // [{label, done}]
  const [doneSlug, setDoneSlug] = useState('');

  const scrollRef = useRef(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 9e9, behavior: 'smooth' }); }, [phase, steps]);

  const runSetup = async () => {
    setErr(null);
    setPhase('working');
    const mark = (label) => setSteps((s) => [...s, { label, done: false }]);
    const finishLast = () => setSteps((s) => s.map((x, i) => (i === s.length - 1 ? { ...x, done: true } : x)));
    try {
      const name = bizName.trim();
      const desiredSlug = slugify(name);
      // 1) Business name + handle. If the derived handle is taken, retry
      //    without the slug (keep the one seeded at signup).
      mark(`Naming your business "${name}"…`);
      try {
        await api.patch('/calendar', { bizName: name, ...(desiredSlug ? { slug: desiredSlug } : {}) });
      } catch {
        await api.patch('/calendar', { bizName: name });
      }
      finishLast();

      // 2) Your main session as a bookable service.
      const priceNum = Number(svc.price) || 0;
      const durNum = Math.max(5, Number(svc.durationMinutes) || 60);
      mark(`Adding "${svc.name.trim() || 'Service'}" — ${durNum} min, $${priceNum}…`);
      await api.put('/calendar/services', {
        services: [{
          name: svc.name.trim() || 'Consultation',
          durationMinutes: durNum,
          price: priceNum,
          visibility: 'public',
        }],
      });
      finishLast();

      // 3) Availability.
      mark(`Setting your hours — ${PRESETS[presetKey].label}…`);
      await api.patch('/calendar', { availability: PRESETS[presetKey].avail });
      finishLast();

      // 4) Mark onboarding complete + read back the final live slug.
      mark('Publishing your booking page…');
      await api.post('/onboarding/complete');
      let finalSlug = desiredSlug;
      try {
        const cal = await api.get('/calendar');
        if (cal?.slug) finalSlug = cal.slug;
      } catch { /* fall back to derived slug */ }
      finishLast();

      setDoneSlug(finalSlug);
      setPhase('done');
    } catch (e) {
      setErr(e?.message || 'Something went wrong — you can try again or set it up manually.');
      setPhase('q3');
    }
  };

  if (phase === 'done') {
    return (
      <div style={{ padding: '4px 0' }}>
        <BookingWin
          slug={doneSlug}
          bizName={bizName.trim()}
          onContinue={onDone}
          continueLabel="Go to my dashboard"
        />
      </div>
    );
  }

  const q1Valid = bizName.trim().length > 0;
  const q2Valid = svc.name.trim().length > 0 && Number(svc.durationMinutes) > 0;

  return (
    <div style={{ maxWidth: 560, margin: '0 auto' }}>
      <div ref={scrollRef} style={{ maxHeight: '52vh', overflowY: 'auto', padding: '4px 2px' }}>
        <IvyBubble>Hi {firstName}! I'm Ivy 👋 I'll get you set up in about a minute — just answer a few things and I'll do the rest.</IvyBubble>

        {/* Q1 */}
        <IvyBubble>First — what should we call your business?</IvyBubble>
        {phase !== 'q1' && <AnswerLine text={bizName.trim()} />}

        {/* Q2 */}
        {(phase === 'q2' || phase === 'q3' || phase === 'working') && (
          <IvyBubble>Great. What's the main service you offer — its name, length, and price?</IvyBubble>
        )}
        {(phase === 'q3' || phase === 'working') && (
          <AnswerLine text={`${svc.name.trim() || 'Service'} · ${svc.durationMinutes} min · $${Number(svc.price) || 0}`} />
        )}

        {/* Q3 */}
        {(phase === 'q3' || phase === 'working') && (
          <IvyBubble>Last one — when are you generally available? I'll set it now (you can fine-tune it anytime).</IvyBubble>
        )}

        {/* Working narration */}
        {phase === 'working' && (
          <div style={{ marginTop: 4 }}>
            {steps.map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 14, color: s.done ? 'var(--fg)' : 'var(--muted)', padding: '5px 0' }}>
                {s.done
                  ? <span style={{ color: 'var(--ok)' }}><Icons.Check size={15} sw={2.4}/></span>
                  : <span style={{ width: 8, height: 8, background: 'var(--accent)', borderRadius: '50%', display: 'inline-block', opacity: 0.6 }}/>}
                {s.label}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Input dock (current question) */}
      {phase !== 'working' && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          {err && <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 10 }}>{err}</div>}

          {phase === 'q1' && (
            <form onSubmit={(e) => { e.preventDefault(); if (q1Valid) setPhase('q2'); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input className="input" autoFocus value={bizName} onChange={(e) => setBizName(e.target.value)}
                placeholder="e.g. Bright & Co." style={{ flex: '1 1 240px', padding: '12px 14px', fontSize: 15 }} />
              <button type="submit" className="btn btn-primary" disabled={!q1Valid} style={{ padding: '12px 20px' }}>Next</button>
            </form>
          )}

          {phase === 'q2' && (
            <form onSubmit={(e) => { e.preventDefault(); if (q2Valid) setPhase('q3'); }} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input className="input" autoFocus value={svc.name} onChange={(e) => setSvc({ ...svc, name: e.target.value })}
                placeholder="Service name — e.g. Consultation" style={{ padding: '12px 14px', fontSize: 15 }} />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label style={{ flex: '1 1 120px', fontSize: 12.5, color: 'var(--muted)' }}>
                  Minutes
                  <input className="input" type="number" min={5} step={5} value={svc.durationMinutes}
                    onChange={(e) => setSvc({ ...svc, durationMinutes: e.target.value })} style={{ padding: '10px 12px', fontSize: 15, marginTop: 4 }} />
                </label>
                <label style={{ flex: '1 1 120px', fontSize: 12.5, color: 'var(--muted)' }}>
                  Price ($)
                  <input className="input" type="number" min={0} step="1" value={svc.price}
                    onChange={(e) => setSvc({ ...svc, price: e.target.value })} placeholder="0" style={{ padding: '10px 12px', fontSize: 15, marginTop: 4 }} />
                </label>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                <button type="button" className="btn btn-ghost" onClick={() => setPhase('q1')} style={{ fontSize: 13 }}>Back</button>
                <button type="submit" className="btn btn-primary" disabled={!q2Valid} style={{ padding: '12px 20px' }}>Next</button>
              </div>
            </form>
          )}

          {phase === 'q3' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(PRESETS).map(([key, p]) => (
                  <button key={key} type="button" onClick={() => setPresetKey(key)}
                    className={`btn ${presetKey === key ? 'btn-primary' : 'btn-outline'}`} style={{ fontSize: 13.5, padding: '9px 14px' }}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                <button type="button" className="btn btn-ghost" onClick={() => setPhase('q2')} style={{ fontSize: 13 }}>Back</button>
                <button type="button" className="btn btn-primary" onClick={runSetup} style={{ padding: '12px 22px', gap: 8 }}>
                  <Icons.Spark size={15} sw={2}/> Set me up
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Escape hatch to the manual wizard */}
      {phase !== 'working' && onExit && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button type="button" onClick={onExit} style={{ background: 'none', border: 0, color: 'var(--muted)', fontSize: 12.5, textDecoration: 'underline', cursor: 'pointer' }}>
            I'll set it up myself instead
          </button>
        </div>
      )}
    </div>
  );
}
