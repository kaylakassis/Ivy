// Automation (/automation; it was Marketing → Workflows).
//
// Two jobs:
//   1. "Ivy noticed": Ivy watches for things the owner does the same way
//      most of the time (api/_lib/workflowSuggest.js) and offers to take
//      them over, showing the evidence so it is never taken on faith.
//   2. "Your workflows": the automations that exist, and a builder.
//
// Each workflow = one TRIGGER + a sequence of ACTIONS:
//   triggers: lead_created | client_created | client_inactive | booking_completed
//   actions:  send_email | send_sms | create_task | send_document
//
// The ready-made client messages (birthday, check-in, book again) are not
// here: they are reminders about clients and live in Clients → Reminders.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useWorkflows } from './state.js';
import WorkflowEditor from './WorkflowEditor.jsx';
import WorkflowTemplatePicker from './WorkflowTemplatePicker.jsx';
import WorkflowSuggestionCard from '../dashboard/WorkflowSuggestionCard.jsx';
import { Link } from 'react-router-dom';
import { confirmAction } from '../../lib/confirm.js';

const TRIGGER_LABELS = {
  lead_created:      'When a lead fills out the contact form',
  client_created:    'When a new client is added',
  client_inactive:   "When a client hasn't booked in a while",
  booking_completed: 'After a booking is completed',
};

const ACTION_LABELS = {
  send_email:    'Send email',
  send_sms:      'Send SMS',
  create_task:   'Create a task',
  send_document: 'Send a document for signing',
  create_invoice: 'Draft an invoice',
  wait:          'Wait',
  if_has_tag:    'If client HAS tag',
  if_lacks_tag:  'If client LACKS tag',
};

export default function Workflows() {
  const { workflows, noticed, loading, error, refresh, create, update, remove } = useWorkflows();
  // Three states for the "create" flow:
  //   pickerOpen        - template picker modal is up
  //   editing === 'new' - blank editor (user clicked "Start from scratch")
  //   editing is a tpl  - editor pre-filled from a template (still creates a new row)
  //   editing is a wf   - editing an existing workflow
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy]       = useState(false);

  if (loading) return <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>Loading workflows…</div>;
  if (error) {
    return (
      <div style={{ padding: 48 }}>
        <div className="card" style={{ padding: 40 }}>
          <EmptyNote icon="Spark" title="Couldn't load workflows" hint={error.message || 'Try refreshing.'}/>
        </div>
      </div>
    );
  }

  // 'new' string OR a template object (from the picker) → CREATE.
  // Existing workflow row (has an `id` AND a `triggerType` already in DB) → UPDATE.
  // Templates carry a `triggerType` too, so distinguish by `id` presence
  // against the live workflows list rather than a typeof check.
  const isExistingWorkflow = editing
    && typeof editing === 'object'
    && editing.id
    && workflows.some((w) => w.id === editing.id);

  const save = async (payload) => {
    setBusy(true);
    try {
      if (isExistingWorkflow) {
        await update(editing.id, payload);
      } else {
        await create(payload);
      }
      setEditing(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>Automation</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4, maxWidth: 640, lineHeight: 1.5 }}>
            Ivy watches for the things you do the same way every time and offers to do them for you. You can also build your own.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setPickerOpen(true)}>
          <Icons.Plus size={13} sw={2}/> New workflow
        </button>
      </div>

      <Noticed noticed={noticed} onChanged={refresh}/>

      <div className="metric-label" style={{ marginBottom: -8 }}>Your workflows</div>
      {workflows.length === 0 ? (
        <div className="card" style={{ padding: 48, textAlign: 'center' }}>
          <EmptyNote icon="Spark" title="No workflows yet"
            hint="Start from a template, or build one from scratch."/>
          <div style={{ marginTop: 18, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => setPickerOpen(true)}>
              Browse templates
            </button>
            <button className="btn btn-outline" onClick={() => setEditing('new')}>
              Start from scratch
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {workflows.map((w) => (
            <WorkflowCard key={w.id}
              workflow={w}
              onToggle={(enabled) => update(w.id, { enabled })}
              onEdit={() => setEditing(w)}
              onDelete={async () => {
                if ((await confirmAction({ title: `Delete workflow "${w.name}"?`, body: 'Runs already logged stay.', confirmLabel: 'Delete', danger: true }))) {
                  await remove(w.id);
                }
              }}/>
          ))}
        </div>
      )}

      <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        Looking for the birthday message, the check-in for quiet clients or the book-again link?{' '}
        <Link to="/clients?view=reminders" style={{ color: 'var(--accent)', fontWeight: 600 }}>They are under Clients, in Reminders.</Link>
      </div>

      {pickerOpen && (
        <WorkflowTemplatePicker
          onPick={(tpl) => { setPickerOpen(false); setEditing(tpl); }}
          onBlank={() => { setPickerOpen(false); setEditing('new'); }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {editing && (
        <WorkflowEditor
          // 'new' or a template → no existing row → pass null/template
          // to the editor so it knows to CREATE. An existing workflow
          // (from the list) → pass the row through for UPDATE.
          workflow={editing === 'new' ? null : editing}
          isNew={!isExistingWorkflow}
          onClose={() => setEditing(null)}
          onSave={save}
          busy={busy}
        />
      )}
    </div>
  );
}

// "Ivy noticed": the pattern Ivy found in what the owner already does, with
// the evidence, and one button to hand it over. When there is nothing yet,
// it says what Ivy is watching for and how much it needs to see first (the
// same thresholds the detector uses), so the box is never a mystery.
function Noticed({ noticed, onChanged }) {
  if (!noticed) return null;
  const { suggestion, evidence } = noticed;
  const habits = Array.isArray(evidence?.habits) ? evidence.habits.filter((h) => h && h.of > 0) : [];
  return (
    <section aria-labelledby="noticed-h" data-automation-noticed={suggestion ? 'found' : 'watching'} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div id="noticed-h" className="metric-label">Ivy noticed</div>
      {suggestion ? (
        <>
          <WorkflowSuggestionCard suggestion={suggestion} onChanged={onChanged} hideLink/>
          {habits.length > 0 && (
            <div className="card" style={{ padding: 14, fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              <div style={{ fontWeight: 650, marginBottom: 4 }}>Why Ivy thinks so</div>
              {habits.map((h) => (
                <div key={h.kind} style={{ marginTop: 4 }}>
                  You {h.label} for {h.matched} of your {h.of} {evidence.consideredLabel || 'most recent'}.
                  {h.note ? ` ${h.note.charAt(0).toUpperCase()}${h.note.slice(1)}.` : ''}
                  {Array.isArray(h.examples) && h.examples.length > 0 && (
                    <div style={{ color: 'var(--muted)', marginTop: 2 }}>For example: {h.examples.slice(0, 3).join('; ')}.</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="card" style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span style={{ width: 32, height: 32, borderRadius: 9, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-2)', color: 'var(--fg-2)' }}>
            <Icons.Spark size={16} sw={1.8}/>
          </span>
          <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.55 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>Nothing yet. Ivy is watching.</div>
            <div style={{ marginTop: 4 }}>
              Ivy looks for two habits: an invoice or a document you send within two days of adding a client, and a message you send within two days of finishing a visit.
              When you have done the same thing for most of your last few clients or visits (at least five), it shows up here with one button to hand it over.
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function WorkflowCard({ workflow, onToggle, onEdit, onDelete }) {
  const summary = workflow.lastRunSummary;
  return (
    <div className="card" style={{
      padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
      border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{
              fontSize: 10.5, fontWeight: 600, letterSpacing: '0.06em',
              textTransform: 'uppercase',
              padding: '2px 8px', borderRadius: 99,
              background: workflow.enabled
                ? 'color-mix(in srgb, var(--ok) 14%, transparent)'
                : 'var(--surface-2)',
              color: workflow.enabled ? 'var(--ok)' : 'var(--muted)',
            }}>{workflow.enabled ? 'On' : 'Off'}</span>
            <button
              onClick={() => onToggle(!workflow.enabled)}
              style={{
                fontSize: 11, color: 'var(--muted)', padding: '2px 6px',
                background: 'transparent', textDecoration: 'underline',
              }}>
              {workflow.enabled ? 'Turn off' : 'Turn on'}
            </button>
          </div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{workflow.name}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>
            {TRIGGER_LABELS[workflow.triggerType] || workflow.triggerType}
            {workflow.triggerType === 'client_inactive' && workflow.triggerConfig?.daysInactive && (
              <> · {workflow.triggerConfig.daysInactive} days</>
            )}
            {workflow.triggerType === 'booking_completed' && workflow.triggerConfig?.daysAfter && (
              <> · {workflow.triggerConfig.daysAfter} days after</>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onEdit} className="btn btn-outline" style={{ padding: '5px 11px', fontSize: 12 }}>
            Edit
          </button>
          <button onClick={onDelete} className="btn btn-ghost"
            style={{ padding: '5px 8px', fontSize: 12, color: 'var(--danger)' }} aria-label="Delete">
            <Icons.Trash size={12}/>
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {(workflow.actions || []).map((a, i) => (
          <span key={i} style={{
            fontSize: 11.5, padding: '3px 9px', borderRadius: 99,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            color: 'var(--fg-2)',
          }}>
            {i + 1}. {ACTION_LABELS[a.type] || a.type}
          </span>
        ))}
      </div>

      {summary && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
          Last run: <span style={{
            color: summary.status === 'succeeded' ? 'var(--ok)'
                 : summary.status === 'failed' ? 'var(--danger)'
                 : 'var(--fg-2)',
          }}>{summary.status}</span> · {timeAgo(summary.triggeredAt)}
        </div>
      )}
    </div>
  );
}

function timeAgo(ts) {
  if (!ts) return '-';
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}
