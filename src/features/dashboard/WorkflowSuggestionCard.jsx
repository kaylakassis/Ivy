// "Ivy noticed a pattern" — offers to automate a repeated new-client follow-up
// the owner keeps doing by hand (detected server-side in api/_lib/workflowSuggest.js
// and returned on /api/dashboard as `workflowSuggestion`). One tap creates the
// proposed client_created workflow via the normal validated create endpoint;
// "Not now" records a dismissal so it stops re-appearing. onChanged() reloads
// the dashboard, which drops the card once the workflow exists / is dismissed.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { api } from '../../lib/api.js';
import { fireConfetti, haptic } from '../../lib/celebrate.js';

// Friendly one-liners for the proposed actions so the owner sees what they're
// agreeing to before they tap Automate.
function describeAction(a) {
  const c = a.config || {};
  switch (a.type) {
    case 'create_task':    return `Add a task — "${c.title || 'Follow up'}"`;
    case 'send_document':  return 'Send your usual document/contract';
    case 'send_email':     return `Email them — "${c.subject || 'a message'}"`;
    case 'send_sms':       return 'Text them';
    case 'wait':           return `Wait ${c.days || 0}d ${c.hours || 0}h`;
    default:               return a.type;
  }
}

export default function WorkflowSuggestionCard({ suggestion, onChanged }) {
  const [busy, setBusy] = useState(null); // 'automate' | 'dismiss'
  const [done, setDone] = useState(false);
  const [err, setErr] = useState(null);

  if (!suggestion || done) return null;
  const wf = suggestion.workflow || {};
  const actions = Array.isArray(wf.actions) ? wf.actions : [];

  const automate = async () => {
    setBusy('automate'); setErr(null);
    try {
      await api.post('/workflows', wf);
      fireConfetti(); haptic();
      setDone(true);
      onChanged?.();
    } catch (e) {
      setErr(e.message || 'Could not create the automation');
    } finally { setBusy(null); }
  };
  const dismiss = async () => {
    setBusy('dismiss'); setErr(null);
    try {
      await api.post('/me/dismiss-suggestion', { signature: suggestion.signature });
      setDone(true);
      onChanged?.();
    } catch (e) {
      setErr(e.message || 'Could not dismiss');
    } finally { setBusy(null); }
  };

  return (
    <div className="card" style={{
      padding: 18, display: 'flex', gap: 14, alignItems: 'flex-start',
      border: '1px solid var(--accent)',
      background: 'color-mix(in srgb, var(--accent-soft) 45%, var(--surface))',
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 9, flexShrink: 0,
        background: 'var(--accent)', color: 'var(--accent-ink)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icons.Spark size={18} sw={1.9}/>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 700 }}>{suggestion.headline || 'Ivy noticed a pattern'}</div>
        <div style={{ fontSize: 13, color: 'var(--fg-2)', marginTop: 3, lineHeight: 1.5 }}>{suggestion.detail}</div>

        <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--muted)' }}>
          Every time you add a client, Ivy will:
        </div>
        <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.6 }}>
          {actions.map((a, i) => <li key={i}>{describeAction(a)}</li>)}
        </ul>

        {err && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--danger)' }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn btn-primary" onClick={automate} disabled={!!busy} style={{ gap: 8 }}>
            {busy === 'automate' ? 'Setting up…' : 'Automate this'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={dismiss} disabled={!!busy} style={{ fontSize: 13 }}>
            {busy === 'dismiss' ? '…' : 'Not now'}
          </button>
          <Link to="/workflows" style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--muted)', textDecoration: 'none' }}>
            Edit in Workflows →
          </Link>
        </div>
      </div>
    </div>
  );
}
