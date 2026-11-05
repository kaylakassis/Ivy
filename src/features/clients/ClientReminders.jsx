// Client drawer: "Appointment reminders" for this one client. Use the
// business default, turn them off for this client, or give them their own
// schedule. Saved on the client (PATCH /api/clients/:id reminderSettings).
// The client's own opt-out from their portal always wins and is shown
// read-only.
import React from 'react';
import { Link } from 'react-router-dom';
import ReminderSchedulePicker, { schedulePreview } from '../calendar/ReminderSchedulePicker.jsx';
import { useReminderSettings, describeSchedule, CLIENT_DEFAULT_MINUTES } from '../../lib/reminders.js';

const MODES = [
  { id: 'default', label: 'Business default' },
  { id: 'off',     label: 'Off for this client' },
  { id: 'custom',  label: 'Custom schedule' },
];

export default function ClientReminders({ client, onSave }) {
  const { data } = useReminderSettings();
  const current = client.reminderSettings || { mode: 'default' };
  const mode = current.mode || 'default';
  const first = (client.name || 'This client').split(/\s+/)[0];
  const bizOff = data?.clients?.enabled === false;
  const bizMinutes = data?.clients?.minutes || CLIENT_DEFAULT_MINUTES;

  const pick = (m) => {
    if (m === mode) return;
    if (m === 'custom') onSave({ reminderSettings: { mode: 'custom', minutes: bizMinutes.slice() } });
    else onSave({ reminderSettings: { mode: m } });
  };

  let note;
  if (client.remindersOptedOut) {
    note = `${first} turned reminders off in their own settings, so they won't get any. Only they can turn them back on.`;
  } else if (bizOff) {
    note = (
      <>Client reminders are off for your whole business. <Link to="/calendar?reminders=1" style={{ color: 'var(--accent)', fontWeight: 600 }}>Turn them on in Reminders</Link>.</>
    );
  } else if (mode === 'off') {
    note = `${first} won't get appointment reminders. Confirmations still go out.`;
  } else if (mode === 'custom') {
    note = `${schedulePreview(first + ' gets', current.minutes || [])} This applies to every service.`;
  } else {
    note = `Follows your business default: ${describeSchedule(bizMinutes)}. A service with its own schedule uses that instead.`;
  }

  return (
    <div data-testid="client-reminders">
      <div className="metric-label" style={{ marginBottom: 8 }}>Appointment reminders</div>
      <div role="radiogroup" aria-label="Appointment reminders" style={{
        display: 'flex', gap: 4, padding: 3, borderRadius: 10,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
      }}>
        {MODES.map((m) => {
          const on = mode === m.id;
          return (
            <button key={m.id} type="button" role="radio" aria-checked={on} onClick={() => pick(m.id)}
              style={{
                flex: 1, minWidth: 0, padding: '7px 6px', borderRadius: 8,
                fontSize: 12, fontWeight: 600, lineHeight: 1.25,
                background: on ? 'var(--surface)' : 'transparent',
                color: on ? 'var(--fg)' : 'var(--muted)',
                border: on ? '1px solid var(--border)' : '1px solid transparent',
                boxShadow: on ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                cursor: 'pointer',
              }}>
              {m.label}
            </button>
          );
        })}
      </div>
      {mode === 'custom' && !client.remindersOptedOut && (
        <div style={{ marginTop: 10 }}>
          <ReminderSchedulePicker idPrefix={`rem-client-${client.id}`} value={current.minutes || []}
            onChange={(minutes) => onSave({ reminderSettings: { mode: 'custom', minutes } })}/>
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>{note}</div>
    </div>
  );
}
