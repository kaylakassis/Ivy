// 'Report a bug' modal. Triggered from the Sidebar user menu.
// Captures the description + auto-attaches:
//   - URL the user was on
//   - viewport (mobile-specific bugs are common)
//   - browser/OS via user-agent on the server
//   - app version (BUILD_SHA injected by vite, falls back to 'dev')
// Severity picker is intentionally simple - most reports come in as
// 'minor' and we re-classify in /admin. The four-level scale matches
// the bug_reports.severity CHECK constraint.
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from './Icons.jsx';
import { api } from '../lib/api.js';
import { useEscapeKey } from '../lib/useEscapeKey.js';

const SEVERITY_OPTIONS = [
  { id: 'info',     label: 'Just thinking aloud', desc: "Feature idea, polish, 'wouldn't it be cool if…'" },
  { id: 'minor',    label: 'Minor annoyance',     desc: 'It works but feels rough.' },
  { id: 'major',    label: "Something's broken",   desc: "I can't do what I'm trying to do." },
  { id: 'critical', label: 'Lost money / data',   desc: 'Charged twice, lost a booking, missing data, etc.' },
];

export default function ReportBugModal({ onClose }) {
  const [title, setTitle]       = useState('');
  const [body, setBody]         = useState('');
  const [severity, setSeverity] = useState('minor');
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState(null);
  const [sent, setSent]         = useState(false);

  useEscapeKey(onClose);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!title.trim()) { setErr('A short title helps a lot - what went wrong?'); return; }
    setBusy(true); setErr(null);
    try {
      const viewport = (typeof window !== 'undefined')
        ? `${window.innerWidth}x${window.innerHeight}`
        : null;
      // __APP_VERSION__ is injected by vite.config.js (define block).
      // typeof guard keeps unit tests / SSR paths happy.
      // eslint-disable-next-line no-undef
      const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
      await api.post('/bug-reports', {
        title: title.trim(),
        body: body.trim() || null,
        severity,
        url: typeof window !== 'undefined' ? window.location.href : null,
        viewport,
        appVersion,
      });
      setSent(true);
    } catch (e2) {
      setErr(e2.message || 'Something went wrong sending the report.');
    } finally {
      setBusy(false);
    }
  };

  return createPortal((
    <div onClick={onClose}
      role="dialog" aria-modal="true" aria-labelledby="bug-report-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(20,18,14,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
      }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="card" style={{
          width: '100%', maxWidth: 480, padding: 24,
          background: 'var(--surface)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.22)',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="metric-label" style={{ marginBottom: 4 }}>Beta feedback</div>
            <h2 id="bug-report-title" style={{
              margin: 0, fontFamily: 'var(--font-display)',
              fontSize: 20, fontWeight: 500, letterSpacing: '-0.01em',
            }}>Report a bug</h2>
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost" style={{ padding: 6 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        {sent ? (
          <div style={{
            padding: 18, background: 'var(--surface-2)', borderRadius: 12,
            border: '1px solid var(--border)', textAlign: 'center',
          }}>
            <div style={{ fontSize: 30 }}>🙏</div>
            <div style={{ fontWeight: 600, fontSize: 15, marginTop: 6 }}>
              Got it - thank you.
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
              We&apos;ll triage this in the next few hours and follow up directly
              if we need more details. You can keep using the app - no need
              to refresh.
            </div>
            <button type="button" onClick={onClose} className="btn btn-primary"
              style={{ marginTop: 14, padding: '8px 18px' }}>
              Close
            </button>
          </div>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              We&apos;re in beta and your eyes catch things ours miss. Tell us
              what happened - we&apos;ll automatically include the page you&apos;re
              on, your browser, and your screen size so we don&apos;t have to
              ask.
            </p>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="metric-label">What went wrong?</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. 'Send invoice button does nothing'"
                disabled={busy}
                autoFocus required maxLength={200}
                style={{
                  padding: '10px 12px', borderRadius: 10,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-strong)',
                  color: 'var(--fg)', fontSize: 14, outline: 'none',
                }}/>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="metric-label">More detail (optional)</span>
              <textarea value={body} onChange={(e) => setBody(e.target.value)}
                placeholder="Steps to reproduce, what you expected, anything that helps."
                disabled={busy} rows={4} maxLength={4000}
                style={{
                  padding: '10px 12px', borderRadius: 10,
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-strong)',
                  color: 'var(--fg)', fontSize: 13.5, outline: 'none',
                  fontFamily: 'inherit', resize: 'vertical', minHeight: 90,
                }}/>
            </label>

            <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <legend className="metric-label" style={{ padding: 0, marginBottom: 4 }}>
                How bad is it?
              </legend>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {SEVERITY_OPTIONS.map((s) => (
                  <label key={s.id} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: '8px 10px', borderRadius: 10,
                    border: `1px solid ${severity === s.id ? 'var(--accent)' : 'var(--border)'}`,
                    background: severity === s.id ? 'color-mix(in srgb, var(--accent) 6%, transparent)' : 'transparent',
                    cursor: busy ? 'default' : 'pointer',
                    transition: 'border-color .12s, background .12s',
                  }}>
                    <input type="radio" name="severity"
                      checked={severity === s.id}
                      onChange={() => setSeverity(s.id)}
                      disabled={busy}
                      style={{ marginTop: 3 }}/>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{s.label}</div>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, lineHeight: 1.45 }}>
                        {s.desc}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </fieldset>

            {err && (
              <div style={{
                padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
                background: 'rgba(155,44,44,0.08)', color: 'var(--danger)',
                border: '1px solid rgba(155,44,44,0.25)',
              }}>{err}</div>
            )}

            <div style={{
              fontSize: 11, color: 'var(--muted-2)', lineHeight: 1.45,
              background: 'var(--surface-2)', borderRadius: 8, padding: '8px 10px',
              border: '1px solid var(--border)',
            }}>
              🔒 We&apos;ll attach the page URL, your browser, and screen size
              automatically. We won&apos;t attach a screenshot or any data
              outside this form.
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" onClick={onClose} className="btn btn-ghost" disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary"
                disabled={busy || !title.trim()}>
                {busy ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  ), document.body);
}
