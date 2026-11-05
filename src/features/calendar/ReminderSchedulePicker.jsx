// Pick a reminder schedule: three ready-made sets as chips, or Custom
// (tick any of the ten times, up to six). Used by Calendar > Reminders and
// the per-client override in the client drawer.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import {
  REMINDER_OPTIONS, REMINDER_PRESETS, MAX_REMINDERS, beatLabel, describeSchedule, sameSet, sortDesc,
} from '../../lib/reminders.js';

// "1 day, 8 hours, 1 hour"
const presetLabel = (mins) => sortDesc(mins).map(beatLabel).join(', ');

// `presets` defaults to the client sets; the owner block passes its own.
export default function ReminderSchedulePicker({ value, onChange, disabled = false, idPrefix = 'rem', presets = REMINDER_PRESETS }) {
  const minutes = sortDesc(value || []);
  const preset = presets.find((p) => sameSet(p.minutes, minutes));
  // Custom is open when the owner picked it, or when the saved schedule
  // is not one of the ready-made sets.
  const [customOpen, setCustomOpen] = useState(!preset && minutes.length > 0);
  const showCustom = customOpen || !preset;
  const atCap = minutes.length >= MAX_REMINDERS;

  const toggle = (m) => {
    if (minutes.includes(m)) {
      if (minutes.length <= 1) return; // keep at least one
      onChange(minutes.filter((x) => x !== m));
    } else if (!atCap) {
      onChange(sortDesc([...minutes, m]));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, opacity: disabled ? 0.55 : 1 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role="radiogroup" aria-label="Reminder schedule">
        {presets.map((p) => {
          const on = !showCustom && preset?.id === p.id;
          return (
            <button key={p.id} type="button" role="radio" aria-checked={on} disabled={disabled}
              onClick={() => { setCustomOpen(false); onChange(p.minutes.slice()); }}
              style={chip(on)}>
              {on && <Icons.Check size={11} sw={2.4}/>} {presetLabel(p.minutes)}
            </button>
          );
        })}
        <button type="button" role="radio" aria-checked={showCustom} disabled={disabled}
          onClick={() => setCustomOpen(true)} style={chip(showCustom)}>
          {showCustom && <Icons.Check size={11} sw={2.4}/>} Custom
        </button>
      </div>

      {showCustom && (
        <div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 6,
          }}>
            {REMINDER_OPTIONS.map((m) => {
              const checked = minutes.includes(m);
              const off = disabled || (!checked && atCap);
              return (
                <label key={m} htmlFor={`${idPrefix}-${m}`} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', borderRadius: 8, fontSize: 13,
                  border: '1px solid ' + (checked ? 'var(--accent-tint, var(--accent))' : 'var(--border)'),
                  background: checked ? 'var(--accent-soft)' : 'var(--surface)',
                  color: off && !checked ? 'var(--muted)' : 'var(--fg)',
                  cursor: off ? 'default' : 'pointer',
                }}>
                  <input id={`${idPrefix}-${m}`} type="checkbox" checked={checked} disabled={off}
                    onChange={() => toggle(m)} style={{ margin: 0 }}/>
                  {beatLabel(m)}
                </label>
              );
            })}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
            {atCap ? `That's the most: up to ${MAX_REMINDERS} reminders.` : `Pick up to ${MAX_REMINDERS}.`}
          </div>
        </div>
      )}
    </div>
  );
}

export function schedulePreview(subject, minutes) {
  const d = describeSchedule(minutes);
  return d ? `${subject} a reminder ${d}.` : `${subject} no reminders.`;
}

export function ReminderSwitch({ checked, disabled, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={onChange} disabled={disabled}
      style={{
        flexShrink: 0,
        width: 36, height: 22, borderRadius: 999,
        background: checked ? 'var(--accent)' : 'var(--border-strong)',
        border: 0, padding: 2,
        cursor: disabled ? 'wait' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}>
      <span style={{
        display: 'block',
        width: 18, height: 18, borderRadius: 999,
        background: '#fff',
        transform: checked ? 'translateX(14px)' : 'translateX(0)',
        transition: 'transform 120ms ease',
        boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
      }}/>
    </button>
  );
}

function chip(on) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '6px 11px', borderRadius: 99, fontSize: 12.5, fontWeight: 550,
    border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
    background: on ? 'var(--accent-soft)' : 'var(--surface)',
    color: on ? 'var(--accent)' : 'var(--fg-2)',
    cursor: 'pointer',
  };
}
