// /workflows — automation builder. The retention surface: turn manual
// follow-up routines (birthday email, win-back-at-60-days, "thanks for
// signing up" nudge) into rules that fire automatically.
//
// Each workflow = one TRIGGER + a sequence of ACTIONS:
//   triggers: lead_created | client_created | client_inactive | booking_completed
//   actions:  send_email | send_sms | create_task | send_document
//
// Tokens for email/SMS body + task title text:
//   {{firstName}}, {{clientName}}, {{businessName}}, {{ownerName}}
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useWorkflows } from './state.js';
import WorkflowEditor from './WorkflowEditor.jsx';

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
};

export default function Workflows() {
  const { workflows, loading, error, create, update, remove } = useWorkflows();
  const [editing, setEditing] = useState(null); // null | 'new' | workflow
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

  const save = async (payload) => {
    setBusy(true);
    try {
      if (editing === 'new') {
        await create(payload);
      } else {
        await update(editing.id, payload);
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
          <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>Workflows</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
            Automate the follow-ups you used to do by hand: birthday emails, win-back nudges, "welcome to the practice" sequences.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Icons.Plus size={13} sw={2}/> New workflow
        </button>
      </div>

      {workflows.length === 0 ? (
        <div className="card" style={{ padding: 48 }}>
          <EmptyNote icon="Spark" title="No workflows yet"
            hint="Create one to automate the follow-up cadence you keep meaning to set up."/>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {workflows.map((w) => (
            <WorkflowCard key={w.id}
              workflow={w}
              onToggle={(enabled) => update(w.id, { enabled })}
              onEdit={() => setEditing(w)}
              onDelete={async () => {
                if (window.confirm(`Delete workflow "${w.name}"? Runs already logged stay.`)) {
                  await remove(w.id);
                }
              }}/>
          ))}
        </div>
      )}

      {editing && (
        <WorkflowEditor
          workflow={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={save}
          busy={busy}
        />
      )}
    </div>
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
            style={{ padding: '5px 8px', fontSize: 12, color: 'var(--danger)' }}>
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
  if (!ts) return '—';
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}
