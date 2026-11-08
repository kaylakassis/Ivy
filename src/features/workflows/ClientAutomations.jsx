// "Ivy sends these for you" (1.0.6): the birthday message, the "we'd love
// to see you again" check-in and the book-again link after a visit. One
// card each: the switch, a plain-text message with a live preview (the
// book-again link has Ivy's fixed message, shown as a preview, and a timing
// instead), email / text, how many quiet days (check-in only), Send me a
// test, and who is due. Off by default; saving the message counts as
// approving it, and the switch only turns on once a message has been saved.
// Server: /api/automations (api/_lib/clientAutomations.js).
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icons } from '../../components/Icons.jsx';

const KINDS = ['birthday', 'quiet', 'rebook'];
const ICON = { birthday: 'Gift', quiet: 'Heart', rebook: 'Repeat' };
const REBOOK_DELAYS = [
  { value: '2h', label: '2 hours after' },
  { value: 'next_morning', label: 'Next morning' },
  { value: '3d', label: '3 days after' },
];
const REBOOK_WHEN = {
  '2h': 'about 2 hours later',
  next_morning: 'the next morning at 9am',
  '3d': '3 days later',
};
const WHEN = {
  birthday: 'On the morning of their birthday, in your time zone.',
  quiet: (days) => `When a client has not booked or messaged for ${days} days and has nothing coming up.`,
  rebook: (delay) => `After you mark a visit complete, ${REBOOK_WHEN[delay] || REBOOK_WHEN.next_morning}. Only between 9am and 7pm in your time zone.`,
};

function Toggle({ checked, disabled, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={onChange} disabled={disabled}
      style={{
        flexShrink: 0, width: 40, height: 24, borderRadius: 999,
        background: checked ? 'var(--accent)' : 'var(--border-strong)',
        border: 0, padding: 2, cursor: disabled ? 'wait' : 'pointer', opacity: disabled ? 0.6 : 1,
      }}>
      <span className="switch-thumb" style={{
        display: 'block', width: 20, height: 20, borderRadius: 999, background: '#fff',
        transform: checked ? 'translateX(16px)' : 'translateX(0)', boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
      }}/>
    </button>
  );
}

// The same fill-in the server does, with sample values for the preview.
export function previewText(template, { firstName, business }) {
  return String(template || '').replace(/\{(first_name|business|booking_link)\}/g, (_, k) => (
    k === 'first_name' ? firstName : k === 'business' ? business : 'joinivy.ai/book/your-business'
  ));
}

export default function ClientAutomations() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const refresh = async () => {
    try { setData(await api.get('/automations?due=1')); setError(null); }
    catch (e) { setError(e.message || 'Could not load'); }
  };
  useEffect(() => { refresh(); }, []);

  if (error) return <div className="card" style={{ padding: 16, color: 'var(--danger)', fontSize: 13 }}>{error}</div>;
  return (
    <section aria-label="Messages Ivy sends for you" style={{ display: 'grid', gap: 12 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 650 }}>Ivy sends these for you</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
          Ready-made messages. Turn one on, make the words yours, and Ivy sends it to the right clients at the right time. Clients who turned off these emails or texts never get them.
        </div>
      </div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        {KINDS.map((kind) => (
          kind === 'rebook'
            ? <RebookCard key={kind} data={data} onSaved={refresh}/>
            : <AutomationCard key={kind} kind={kind} data={data} onSaved={refresh}/>
        ))}
      </div>
    </section>
  );
}

function AutomationCard({ kind, data, onSaved }) {
  const a = data?.automations?.[kind];
  const due = data?.due?.[kind];
  const business = data?.business || 'your business';
  const [template, setTemplate] = useState('');
  const [channels, setChannels] = useState({ email: true, sms: false });
  const [quietDays, setQuietDays] = useState(42);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null); // 'save' | 'test' | 'toggle'
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!a) return;
    setTemplate(a.template || '');
    setChannels(a.channels || { email: true, sms: false });
    if (a.quietDays) setQuietDays(a.quietDays);
  }, [a]);

  if (!a) return <div className="card" style={{ padding: 16, minHeight: 120, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  const Icon = Icons[ICON[kind]] || Icons.Spark;
  const dirty = template !== (a.template || '') || channels.email !== a.channels.email || channels.sms !== a.channels.sms
    || (kind === 'quiet' && Number(quietDays) !== Number(a.quietDays));
  const patch = () => ({
    kind, template, channels,
    ...(kind === 'quiet' ? { quietDays: Number(quietDays) } : {}),
  });

  const save = async (extra = {}) => {
    setBusy('save'); setErr(null); setMsg(null);
    try {
      await api.patch('/automations', { ...patch(), ...extra });
      setMsg(extra.enabled === true ? 'Saved and turned on.' : 'Saved.');
      await onSaved();
    } catch (e) { setErr(e.message || 'Could not save'); }
    finally { setBusy(null); }
  };
  const toggle = async () => {
    if (!a.enabled) {
      // Turning on: the message on screen is saved (and so approved) with it.
      setOpen(true);
      return save({ enabled: true });
    }
    setBusy('toggle'); setErr(null); setMsg(null);
    try { await api.patch('/automations', { kind, enabled: false }); setMsg('Turned off. Nothing more goes out.'); await onSaved(); }
    catch (e) { setErr(e.message || 'Could not change'); }
    finally { setBusy(null); }
  };
  const test = async () => {
    setBusy('test'); setErr(null); setMsg(null);
    try { const r = await api.post('/automations/test', { kind, template }); setMsg(`Test sent to ${r.to}.`); }
    catch (e) { setErr(e.message || 'Could not send the test'); }
    finally { setBusy(null); }
  };

  const when = kind === 'quiet' ? WHEN.quiet(quietDays) : WHEN.birthday;
  const dueLine = kind === 'birthday'
    ? (due?.clients?.length ? `${due.clients.length === 1 ? '1 birthday' : `${due.clients.length} birthdays`} this week: ${due.clients.slice(0, 3).map((c) => c.name).join(', ')}${due.clients.length > 3 ? ` and ${due.clients.length - 3} more` : ''}` : 'No birthdays this week.')
    : (due ? (due.count ? `${due.count === 1 ? '1 client is' : `${due.count} clients are`} due for this: ${due.clients.slice(0, 3).map((c) => c.name).join(', ')}${due.count > 3 ? ` and ${due.count - 3} more` : ''}` : 'Nobody is due for this right now.') : null);

  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }} data-automation={kind}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', flexShrink: 0,
          background: 'color-mix(in srgb, var(--accent) 12%, var(--surface))', color: 'var(--accent)' }}>
          <Icon size={17} sw={1.9}/>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{a.label}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{when}</div>
        </div>
        <Toggle checked={a.enabled} disabled={busy === 'toggle' || busy === 'save'} onChange={toggle} label={`${a.label} on or off`}/>
      </div>

      <div style={{ fontSize: 12.5, lineHeight: 1.5, padding: '8px 10px', borderRadius: 10, background: 'var(--surface-2)', color: 'var(--fg-2)' }}>
        {a.note}
        {a.sentThisMonth > 0 && <> Sent to {a.sentThisMonth} {a.sentThisMonth === 1 ? 'client' : 'clients'} this month.</>}
      </div>

      {dueLine && (
        <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{dueLine}{!a.enabled && due && (kind === 'birthday' ? due.clients?.length : due.count) ? ' (nothing is sent while this is off)' : ''}</div>
      )}

      <button type="button" className="btn btn-ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ justifyContent: 'space-between', padding: '6px 4px', fontSize: 13 }}>
        <span>{open ? 'Hide the message' : 'Edit the message'}</span>
        <Icons.ArrowDown size={13} sw={2} style={{ transform: open ? 'rotate(180deg)' : 'none' }}/>
      </button>

      {open && (
        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ display: 'grid', gap: 6, fontSize: 12.5, color: 'var(--muted)' }}>
            The message
            <textarea className="input" rows={4} maxLength={data?.maxTemplateChars || 600} value={template}
              onChange={(e) => setTemplate(e.target.value)} style={{ resize: 'vertical', fontSize: 14, lineHeight: 1.45 }}/>
          </label>
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            Words in curly brackets are filled in for each client: <code>{'{first_name}'}</code> becomes their first name, <code>{'{business}'}</code> your business name, <code>{'{booking_link}'}</code> a link to book (their usual service when they have one).
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 4, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>Preview</div>
            <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px dashed var(--border-strong)', fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} data-preview>
              {previewText(template, { firstName: 'Maya', business })}
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 13 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={channels.email} onChange={(e) => setChannels((c) => ({ ...c, email: e.target.checked }))}/> Email
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={channels.sms} onChange={(e) => setChannels((c) => ({ ...c, sms: e.target.checked }))}/> Text (only clients who agreed to texts)
            </label>
          </div>
          {kind === 'quiet' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              Quiet after
              <input className="input" type="number" min={7} max={365} value={quietDays} onChange={(e) => setQuietDays(e.target.value)}
                style={{ width: 80, textAlign: 'center' }} aria-label="Quiet days"/>
              days
            </label>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="btn btn-primary" onClick={() => save()} disabled={!!busy || (!dirty && !!a.templateApprovedAt)}>
              {busy === 'save' ? 'Saving…' : (a.templateApprovedAt ? 'Save' : 'Save message')}
            </button>
            <button type="button" className="btn btn-outline" onClick={test} disabled={!!busy}>
              <Icons.Mail size={13} sw={1.9}/> {busy === 'test' ? 'Sending…' : 'Send me a test'}
            </button>
          </div>
        </div>
      )}
      {msg && <div role="status" style={{ fontSize: 12.5, color: 'var(--ok, #2c8a4a)' }}>{msg}</div>}
      {err && <div role="alert" style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
    </div>
  );
}

// The book-again link: Ivy's fixed message (the same one as "Send rebook
// link" on a booking), so the card offers the timing and the channels, a
// preview, and a test instead of a message to write.
function RebookCard({ data, onSaved }) {
  const a = data?.automations?.rebook;
  const due = data?.due?.rebook;
  const business = data?.business || 'your business';
  const service = data?.sampleService || 'appointment';
  const [channels, setChannels] = useState({ email: true, sms: false });
  const [delay, setDelay] = useState('next_morning');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null); // 'save' | 'test' | 'toggle'
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!a) return;
    setChannels(a.channels || { email: true, sms: false });
    setDelay(a.delay || 'next_morning');
  }, [a]);

  if (!a) return <div className="card" style={{ padding: 16, minHeight: 120, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>;
  const Icon = Icons[ICON.rebook] || Icons.Spark;
  const dirty = channels.email !== a.channels.email || channels.sms !== a.channels.sms || delay !== a.delay;

  const save = async (extra = {}) => {
    setBusy('save'); setErr(null); setMsg(null);
    try {
      await api.patch('/automations', { kind: 'rebook', channels, delay, ...extra });
      setMsg(extra.enabled === true ? 'Turned on. Ivy sends it after each visit you mark complete.' : 'Saved.');
      await onSaved();
    } catch (e) { setErr(e.message || 'Could not save'); }
    finally { setBusy(null); }
  };
  const toggle = async () => {
    if (!a.enabled) return save({ enabled: true });
    setBusy('toggle'); setErr(null); setMsg(null);
    try { await api.patch('/automations', { kind: 'rebook', enabled: false }); setMsg('Turned off. Nothing more goes out.'); await onSaved(); }
    catch (e) { setErr(e.message || 'Could not change'); }
    finally { setBusy(null); }
  };
  const test = async () => {
    setBusy('test'); setErr(null); setMsg(null);
    try { const r = await api.post('/automations/test', { kind: 'rebook' }); setMsg(`Test sent to ${r.to}.`); }
    catch (e) { setErr(e.message || 'Could not send the test'); }
    finally { setBusy(null); }
  };

  // A sample day for the preview; each client's is picked from their own visits.
  const sampleDay = new Date(Date.now() + 14 * 86400000).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const names = (list) => list.slice(0, 3).map((c) => c.name).join(', ');
  const n = due?.count || 0;
  const dueLine = !due ? null
    : n === 0 ? (a.enabled ? 'Nobody is waiting for one right now.' : 'No recent visits would get one right now.')
      : a.enabled
        ? `${n === 1 ? '1 client gets one' : `${n} clients get one`} next: ${due.clients.slice(0, 3).map((c) => (c.sendsAtLabel ? `${c.name} (${c.sendsAtLabel})` : c.name)).join(', ')}${n > 3 ? ` and ${n - 3} more` : ''}`
        : `${n === 1 ? '1 client' : `${n} clients`} from recent visits would get one: ${names(due.clients)}${n > 3 ? ` and ${n - 3} more` : ''} (nothing is sent while this is off)`;

  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }} data-automation="rebook">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', flexShrink: 0,
          background: 'color-mix(in srgb, var(--accent) 12%, var(--surface))', color: 'var(--accent)' }}>
          <Icon size={17} sw={1.9}/>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{a.label}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>{WHEN.rebook(a.delay)}</div>
        </div>
        <Toggle checked={a.enabled} disabled={busy === 'toggle' || busy === 'save'} onChange={toggle} label={`${a.label} on or off`}/>
      </div>

      <div style={{ fontSize: 12.5, lineHeight: 1.5, padding: '8px 10px', borderRadius: 10, background: 'var(--surface-2)', color: 'var(--fg-2)' }}>
        {a.note}
        {a.sentThisMonth > 0 && <> Sent to {a.sentThisMonth} {a.sentThisMonth === 1 ? 'client' : 'clients'} this month.</>}
      </div>

      {dueLine && <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.45 }}>{dueLine}</div>}

      <button type="button" className="btn btn-ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ justifyContent: 'space-between', padding: '6px 4px', fontSize: 13 }}>
        <span>{open ? 'Hide timing and message' : 'Timing and message'}</span>
        <Icons.ArrowDown size={13} sw={2} style={{ transform: open ? 'rotate(180deg)' : 'none' }}/>
      </button>

      {open && (
        <div style={{ display: 'grid', gap: 12 }}>
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 6 }}>
            <legend style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6 }}>When it goes out</legend>
            <div role="radiogroup" aria-label="When it goes out" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {REBOOK_DELAYS.map((d) => (
                <button key={d.value} type="button" role="radio" aria-checked={delay === d.value}
                  className={delay === d.value ? 'btn btn-primary' : 'btn btn-outline'}
                  onClick={() => setDelay(d.value)} style={{ fontSize: 13, padding: '6px 12px' }}>
                  {d.label}
                </button>
              ))}
            </div>
          </fieldset>
          <div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 4, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>What clients get</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.45 }}>The same message as Send rebook link on a booking. Each client sees the service they just had and a day picked from their own visits.</div>
            <div style={{ padding: '10px 12px', borderRadius: 10, border: '1px dashed var(--border-strong)', fontSize: 13.5, lineHeight: 1.5, overflowWrap: 'anywhere', display: 'grid', gap: 8 }} data-preview>
              <div><strong>Ready for your next {service}?</strong></div>
              <div>Hi Maya,</div>
              <div>Booking your next {service} with {business} takes one tap.</div>
              <div>We picked {sampleDay} at 10:00 am for you. You can choose another time if that one does not suit.</div>
              <div><span className="btn btn-primary" aria-hidden="true" style={{ pointerEvents: 'none', fontSize: 12.5, padding: '4px 12px' }}>Book again</span></div>
              {channels.sms && (
                <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>
                  Text: Hi Maya, ready for your next {service} with {business}? Book again here: joinivy.ai/book/your-business
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 13 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={channels.email} onChange={(e) => setChannels((c) => ({ ...c, email: e.target.checked }))}/> Email
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={channels.sms} onChange={(e) => setChannels((c) => ({ ...c, sms: e.target.checked }))}/> Text (only clients who agreed to texts)
            </label>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="btn btn-primary" onClick={() => save()} disabled={!!busy || !dirty}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn btn-outline" onClick={test} disabled={!!busy}>
              <Icons.Mail size={13} sw={1.9}/> {busy === 'test' ? 'Sending…' : 'Send me a test'}
            </button>
          </div>
        </div>
      )}
      {msg && <div role="status" style={{ fontSize: 12.5, color: 'var(--ok, #2c8a4a)' }}>{msg}</div>}
      {err && <div role="alert" style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
    </div>
  );
}
