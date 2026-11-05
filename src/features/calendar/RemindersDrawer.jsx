// Calendar > Reminders: when appointment reminders go out, in two
// separate blocks. "Reminders to your clients" is the business-wide
// default (services and single clients can still have their own);
// "Reminders to you" is the owner's own heads-up and never changes what
// clients get. Saved with PATCH /api/calendar/reminders.
import React, { useEffect, useState } from 'react';
import Drawer from './Drawer.jsx';
import ReminderSchedulePicker, { ReminderSwitch, schedulePreview } from './ReminderSchedulePicker.jsx';
import { api } from '../../lib/api.js';
import { useReminderSettings, setReminderSettingsCache, OWNER_PRESETS } from '../../lib/reminders.js';

const card = {
  padding: 16, borderRadius: 12, border: '1px solid var(--border)',
  background: 'var(--surface)', marginBottom: 16,
};

export default function RemindersDrawer({ onClose }) {
  const { data, err: loadErr } = useReminderSettings();
  const [clients, setClients] = useState(null);
  const [owner, setOwner] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data && !clients) {
      setClients(structuredClone(data.clients));
      setOwner(structuredClone(data.owner));
    }
  }, [data, clients]);

  const save = async () => {
    setBusy(true); setErr(null); setSaved(false);
    try {
      const r = await api.patch('/calendar/reminders', { clients, owner });
      setReminderSettingsCache(r);
      setClients(structuredClone(r.clients));
      setOwner(structuredClone(r.owner));
      setSaved(true);
    } catch (e) {
      setErr(e.message || 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer title="Reminders" subtitle="When you and your clients hear about upcoming appointments" onClose={onClose} width={520}>
      {!clients && !loadErr && <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div>}
      {loadErr && !clients && <div style={{ fontSize: 13, color: 'var(--danger)' }}>{loadErr}</div>}

      {clients && owner && (
        <>
          <section style={card} data-testid="reminders-clients">
            <BlockHeader
              title="Reminders to your clients"
              on={clients.enabled}
              onToggle={() => { setSaved(false); setClients({ ...clients, enabled: !clients.enabled }); }}
              label="Send reminders to clients"/>
            {clients.enabled ? (
              <>
                <ReminderSchedulePicker idPrefix="rem-clients" value={clients.minutes}
                  onChange={(minutes) => { setSaved(false); setClients({ ...clients, minutes }); }}/>
                <Preview text={schedulePreview('Clients get', clients.minutes)}/>
                <Channels
                  items={[
                    { k: 'email', label: 'Email' },
                    { k: 'sms', label: 'Text' },
                    { k: 'push', label: 'App notification' },
                  ]}
                  value={clients.channels}
                  onChange={(channels) => { setSaved(false); setClients({ ...clients, channels }); }}/>
                <Hint>
                  Texts only go to clients who said yes to texts{data?.smsAvailable ? '' : ' (texting is not set up yet)'}.
                  A service or a single client can have its own schedule, and any client can turn reminders off for themselves.
                </Hint>
              </>
            ) : (
              <Hint>Clients won't get any appointment reminders from you. Confirmations still go out when they book.</Hint>
            )}
          </section>

          <section style={card} data-testid="reminders-owner">
            <BlockHeader
              title="Reminders to you"
              on={owner.enabled}
              onToggle={() => { setSaved(false); setOwner({ ...owner, enabled: !owner.enabled }); }}
              label="Send reminders to me"/>
            {owner.enabled ? (
              <>
                <ReminderSchedulePicker idPrefix="rem-owner" value={owner.minutes} presets={OWNER_PRESETS}
                  onChange={(minutes) => { setSaved(false); setOwner({ ...owner, minutes }); }}/>
                <Preview text={schedulePreview('You get', owner.minutes).replace(/\.$/, ' each appointment.')}/>
                <Channels
                  items={[
                    { k: 'email', label: 'Email' },
                    { k: 'push', label: 'App notification' },
                  ]}
                  value={owner.channels}
                  onChange={(channels) => { setSaved(false); setOwner({ ...owner, channels }); }}/>
                <Hint>
                  Just for you. This never changes what your clients get.
                  An appointment you gave to a helper reminds that helper instead.
                </Hint>
              </>
            ) : (
              <Hint>You won't get reminders about your appointments. Your clients' reminders are not affected.</Hint>
            )}
          </section>

          {err && (
            <div role="alert" style={{
              marginBottom: 12, padding: '8px 12px', borderRadius: 8,
              background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
              color: 'var(--danger)', fontSize: 12.5,
            }}>{err}</div>
          )}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn btn-outline" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Close</button>
            <button className="btn btn-primary" onClick={save} disabled={busy}
              style={{ flex: 2, justifyContent: 'center', opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Saving…' : saved ? 'Saved' : 'Save reminders'}
            </button>
          </div>
        </>
      )}
    </Drawer>
  );
}

function BlockHeader({ title, on, onToggle, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: on ? 14 : 8 }}>
      <div style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600 }}>{title}</div>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{on ? 'On' : 'Off'}</span>
      <ReminderSwitch checked={on} onChange={onToggle} label={label}/>
    </div>
  );
}

function Preview({ text }) {
  return (
    <div data-testid="reminder-preview" style={{
      marginTop: 12, padding: '9px 12px', borderRadius: 8,
      background: 'var(--surface-2)', fontSize: 13, color: 'var(--fg)', lineHeight: 1.45,
    }}>{text}</div>
  );
}

function Channels({ items, value, onChange }) {
  const onCount = items.filter((it) => value[it.k]).length;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Send by</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {items.map((it) => {
          const checked = !!value[it.k];
          // Keep at least one way to reach people while the block is on.
          const locked = checked && onCount === 1;
          return (
            <label key={it.k} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13,
              padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)',
              cursor: locked ? 'default' : 'pointer',
            }}>
              <input type="checkbox" checked={checked} disabled={locked}
                onChange={() => onChange({ ...value, [it.k]: !checked })} style={{ margin: 0 }}/>
              {it.label}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function Hint({ children }) {
  return <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>{children}</div>;
}
