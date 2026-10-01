// Talk-to-text for any composer. Tap once to start listening, tap again
// to stop; the live transcript is appended to whatever was already
// typed. Built on the same Web Speech hook the Messages composer uses
// (src/lib/speech.js), so it behaves identically everywhere. Renders
// nothing when the browser has no speech recognition, so there is never
// a dead button.
import React, { useEffect, useRef } from 'react';
import { useDictation } from '../lib/speech.js';

export default function DictationButton({ value, onChange, onListening, onError, size = 34, disabled }) {
  const dictation = useDictation();
  const prefixRef = useRef('');
  const lastRef = useRef('');

  useEffect(() => { onListening?.(dictation.listening); }, [dictation.listening, onListening]);
  useEffect(() => { if (dictation.error) onError?.(dictation.error); }, [dictation.error, onError]);

  // The parent cleared the field (sent the message) while we were still
  // listening: stop, so the next message starts from a clean transcript.
  useEffect(() => {
    if (dictation.listening && value === '' && lastRef.current !== '') dictation.stop();
  }, [value, dictation]);

  if (!dictation.supported) return null;

  const toggle = () => {
    if (dictation.listening) { dictation.stop(); return; }
    prefixRef.current = value && value.trim() ? value.trim() + ' ' : '';
    lastRef.current = '';
    dictation.start((transcript) => {
      lastRef.current = prefixRef.current + transcript;
      onChange(lastRef.current);
    });
  };

  const on = dictation.listening;
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      title={on ? 'Stop listening' : 'Talk instead of typing'}
      aria-label={on ? 'Stop listening' : 'Talk instead of typing'}
      aria-pressed={on}
      style={{
        flex: '0 0 auto',
        width: size, height: size, borderRadius: 999,
        border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
        background: on ? 'var(--accent-soft)' : 'var(--surface)',
        color: on ? 'var(--accent)' : 'var(--fg-2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background .12s, border-color .12s',
        animation: on ? 'msg-mic-pulse 1.4s ease-in-out infinite' : undefined,
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="9" y="3" width="6" height="12" rx="3"/>
        <path d="M5 11a7 7 0 0 0 14 0"/>
        <path d="M12 18v3"/>
      </svg>
    </button>
  );
}
