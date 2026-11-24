// The "why are you leaving?" form: a short list of reasons (pick any) and
// an optional comment. Used by the sheet inside the app, the page the email
// link opens, and the delete-account screen. The reasons mirror
// api/_lib/exitInterview.js; the server ignores anything not on its list.
import React from 'react';

export const EXIT_REASONS = [
  { id: 'too_expensive', label: 'It costs too much' },
  { id: 'not_using', label: 'I was not using it enough' },
  { id: 'too_complicated', label: 'It was too hard to figure out' },
  { id: 'missing_feature', label: 'It is missing something I need' },
  { id: 'switched', label: 'I am using something else' },
  { id: 'not_working', label: 'Things did not work properly' },
  { id: 'business_closed', label: 'I closed or paused my business' },
  { id: 'taking_a_break', label: 'I am taking a break and may be back' },
  { id: 'other', label: 'Something else' },
];
// For an owner whose free trial ran out: "what stopped you from subscribing?"
export const TRIAL_REASONS = [
  { id: 'too_expensive', label: 'It costs too much' },
  { id: 'not_enough_time', label: 'I did not have time to try it properly' },
  { id: 'too_complicated', label: 'It was too hard to figure out' },
  { id: 'missing_feature', label: 'It is missing something I need' },
  { id: 'switched', label: 'I am using something else' },
  { id: 'not_working', label: 'Things did not work properly' },
  { id: 'business_closed', label: 'I closed or paused my business' },
  { id: 'still_deciding', label: 'I am still deciding' },
  { id: 'other', label: 'Something else' },
];
export const reasonsFor = (kind) => (kind === 'trial' ? TRIAL_REASONS : EXIT_REASONS);
// The question, worded for who is being asked.
export const EXIT_COPY = {
  cancel: { title: 'Before you go, what made you cancel?', short: 'What made you cancel?' },
  trial: { title: 'What stopped you from subscribing?', short: 'What stopped you from subscribing?' },
};
export const MAX_COMMENT_CHARS = 1000;

// A prompt for the comment box that follows what they picked.
function commentHint(reasons) {
  if (reasons.includes('missing_feature')) return 'What were you missing?';
  if (reasons.includes('too_complicated')) return 'What was hard to figure out?';
  if (reasons.includes('not_working')) return 'What went wrong?';
  if (reasons.includes('switched')) return 'What does it do better for you?';
  if (reasons.includes('not_enough_time')) return 'What would have made it quicker to try?';
  if (reasons.includes('still_deciding')) return 'What would help you decide?';
  return 'Anything you would like us to know? (optional)';
}

export default function ExitInterviewForm({ reasons, comment, onChange, options = EXIT_REASONS, compact = false }) {
  const toggle = (id) => onChange({ reasons: reasons.includes(id) ? reasons.filter((r) => r !== id) : [...reasons, id], comment });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div role="group" aria-label="Reasons" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {options.map((r) => {
          const on = reasons.includes(r.id);
          return (
            <label key={r.id} data-exit-reason={r.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: compact ? '7px 10px' : '10px 12px', borderRadius: 10, cursor: 'pointer',
              border: `1px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`,
              background: on ? 'var(--accent-soft)' : 'var(--surface)', fontSize: 14, minHeight: compact ? 0 : 44,
            }}>
              <input type="checkbox" checked={on} onChange={() => toggle(r.id)} style={{ width: 16, height: 16, flexShrink: 0 }}/>
              <span>{r.label}</span>
            </label>
          );
        })}
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 550, color: 'var(--fg-2)' }}>{commentHint(reasons)}</span>
        <textarea value={comment} maxLength={MAX_COMMENT_CHARS} rows={compact ? 2 : 3}
          onChange={(e) => onChange({ reasons, comment: e.target.value })}
          style={{
            width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border-strong)',
            background: 'var(--surface)', color: 'var(--fg)', fontSize: 16, lineHeight: 1.45, resize: 'vertical', outline: 'none',
          }}/>
      </label>
    </div>
  );
}
