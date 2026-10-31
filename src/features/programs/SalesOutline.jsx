// Sales page: "What's inside". Module titles with their lesson titles
// (no content), and the lessons the owner marked as a free preview,
// which anyone can open right here.
import React, { useState } from 'react';
import { Icons } from '../../components/Icons.jsx';
import LessonContent from './LessonContent.jsx';
import { groupLessons } from './CourseOutline.jsx';
import { lessonMeta } from './courseUi.jsx';

export default function SalesOutline({ outline = [], modules = [], previews = [] }) {
  const [open, setOpen] = useState(null);
  if (!outline.length) return null;
  const byId = new Map(previews.map((p) => [p.id, p]));
  const groups = groupLessons(outline, modules);
  const head = { padding: '12px 16px 6px', fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ ...head, padding: 0 }}>
        What's inside · {outline.length} lesson{outline.length === 1 ? '' : 's'}{modules.length ? ` in ${modules.length} module${modules.length === 1 ? '' : 's'}` : ''}
      </div>
      {groups.map(({ module: m, lessons }) => (
        <div key={m?.id || 'top'} className="card" style={{ padding: 4 }}>
          {m && (
            <div style={{ padding: '12px 16px 8px' }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{m.title}</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{lessons.length} lesson{lessons.length === 1 ? '' : 's'}{m.description ? ` · ${m.description}` : ''}</div>
            </div>
          )}
          {lessons.map((o, i) => {
            const meta = lessonMeta(o.type); const Icon = meta.icon;
            const preview = byId.get(o.id);
            const isOpen = open === o.id && preview;
            return (
              <div key={o.id} style={{ borderTop: m || i > 0 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px' }}>
                  <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon size={14}/></span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.title}</span>
                  {preview ? (
                    <button type="button" className="btn btn-outline" onClick={() => setOpen(isOpen ? null : o.id)} style={{ padding: '4px 10px', minHeight: 30, fontSize: 12.5 }}>{isOpen ? 'Close' : 'Free preview'}</button>
                  ) : (
                    <><span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{meta.label}</span><Icons.Lock size={13} stroke="var(--muted-2)"/></>
                  )}
                </div>
                {isOpen && <div style={{ padding: '4px 16px 16px' }}><LessonContent item={preview}/></div>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
