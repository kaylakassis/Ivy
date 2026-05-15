// Modal that appears when the user clicks "New workflow". Lets them
// either pick a pre-built template (most owners) or start from a blank
// editor (current behavior, preserved). Picking a template just
// pre-fills the editor — every field stays editable before save.
import React, { useMemo, useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import { WORKFLOW_TEMPLATES, TEMPLATE_CATEGORIES, getTemplateById } from './templates.js';

const TRIGGER_BLURB = {
  lead_created:      'New lead arrives',
  client_created:    'New client added',
  client_inactive:   'Client goes quiet',
  booking_completed: 'After a session',
};

const ACTION_LABEL = {
  send_email:    'Email',
  send_sms:      'SMS',
  create_task:   'Task',
  send_document: 'Document',
  wait:          'Wait',
  if_has_tag:    'If tag',
  if_lacks_tag:  'If no tag',
};

export default function WorkflowTemplatePicker({ onPick, onBlank, onClose }) {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return WORKFLOW_TEMPLATES.filter((t) => {
      if (activeCategory !== 'all' && t.category !== activeCategory) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
      );
    });
  }, [query, activeCategory]);

  const pick = (id) => {
    const tpl = getTemplateById(id);
    if (tpl) onPick(tpl);
  };

  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 220,
        background: 'rgba(10,12,8,0.55)', display: 'flex', justifyContent: 'center',
        alignItems: 'flex-start', padding: '4vh 16px',
      }}>
      <div className="card" style={{
        width: '100%', maxWidth: 780, padding: 0,
        display: 'flex', flexDirection: 'column',
        maxHeight: '92vh',
      }}>
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>Start a new workflow</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
              Pick a template or build one from scratch. Either way, every field stays editable before you save.
            </div>
          </div>
          <button onClick={onClose} className="btn btn-ghost" style={{ padding: 8 }}
            aria-label="Close template picker">
            <Icons.X size={15}/>
          </button>
        </div>

        <div style={{
          padding: '12px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
            <input
              type="search"
              className="input"
              placeholder="Search templates…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ padding: '8px 11px 8px 32px', fontSize: 13, width: '100%' }}/>
            <span style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--muted)', pointerEvents: 'none', display: 'flex',
            }}>
              <Icons.Search size={13}/>
            </span>
          </div>
          <button
            type="button"
            className="btn btn-outline"
            onClick={onBlank}
            style={{ fontSize: 12, padding: '6px 12px' }}>
            <Icons.Plus size={12} sw={2}/> Start from scratch
          </button>
        </div>

        <div style={{
          padding: '10px 20px', borderBottom: '1px solid var(--border)',
          display: 'flex', gap: 6, flexWrap: 'wrap',
        }}>
          <CategoryChip
            label={`All (${WORKFLOW_TEMPLATES.length})`}
            active={activeCategory === 'all'}
            onClick={() => setActiveCategory('all')}/>
          {TEMPLATE_CATEGORIES.map((c) => {
            const count = WORKFLOW_TEMPLATES.filter((t) => t.category === c).length;
            return (
              <CategoryChip
                key={c}
                label={`${c} (${count})`}
                active={activeCategory === c}
                onClick={() => setActiveCategory(c)}/>
            );
          })}
        </div>

        <div style={{
          overflowY: 'auto', padding: 16,
          display: 'grid', gap: 10,
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        }}>
          {filtered.length === 0 ? (
            <div style={{
              gridColumn: '1 / -1',
              padding: 40, textAlign: 'center',
              color: 'var(--muted)', fontSize: 13,
            }}>
              No templates match — try a different search.
            </div>
          ) : (
            filtered.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                onPick={() => pick(t.id)}/>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function CategoryChip({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 11.5, fontWeight: 500,
        padding: '5px 11px', borderRadius: 99,
        border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
        background: active ? 'var(--accent-soft)' : 'var(--surface)',
        color: active ? 'var(--accent)' : 'var(--fg-2)',
        cursor: 'pointer',
      }}>
      {label}
    </button>
  );
}

function TemplateCard({ template, onPick }) {
  return (
    <button
      type="button"
      onClick={onPick}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
      style={{
        textAlign: 'left',
        padding: 14, borderRadius: 12,
        border: '1px solid var(--border)',
        background: 'var(--surface)',
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 10,
        transition: 'border-color .15s',
      }}>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)' }}>
          {template.name}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
          {template.summary}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
        <Pill>{TRIGGER_BLURB[template.triggerType] || template.triggerType}</Pill>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>→</span>
        {summarizeActions(template.actions).map((a, i) => (
          <Pill key={i} tone="muted">{a}</Pill>
        ))}
      </div>
    </button>
  );
}

function Pill({ children, tone }) {
  const styles = tone === 'muted'
    ? { background: 'var(--surface-2)', color: 'var(--muted)', border: '1px solid var(--border)' }
    : { background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid transparent' };
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 500,
      padding: '2px 7px', borderRadius: 99,
      whiteSpace: 'nowrap',
      ...styles,
    }}>{children}</span>
  );
}

// Compact action summary for the card. Collapses repeated types
// ("Email · Email · Email" → "3× Email") so the chip row stays tidy.
function summarizeActions(actions) {
  const out = [];
  for (const a of actions || []) {
    const label = ACTION_LABEL[a.type] || a.type;
    const last = out[out.length - 1];
    if (last && last.label === label) {
      last.count++;
    } else {
      out.push({ label, count: 1 });
    }
  }
  return out.map((x) => x.count > 1 ? `${x.count}× ${x.label}` : x.label);
}
