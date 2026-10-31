// Shared building blocks for programs: the content list (PDF / post /
// video renderers) and the community feed. Used by the owner's builder
// and by the client portal, so members see exactly what the coach sees.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { MiniMarkdown } from '../../lib/miniMarkdown.jsx';

export const fmtPrice = (cents, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: cents % 100 ? 2 : 0 }).format((cents || 0) / 100);
export const billingLabel = (b) => b === 'month' ? '/ month' : b === 'year' ? '/ year' : 'one-time';
export const TYPE_META = {
  pdf:   { icon: 'Doc',      label: 'PDF' },
  post:  { icon: 'Chat',     label: 'Lesson' },
  video: { icon: 'Globe',    label: 'Video' },
};

// One content item, expanded inline. Videos play inside the app via the
// privacy-enhanced YouTube embed (never a new tab); PDFs render in an
// inline viewer with an "open" fallback.
export function ContentItem({ item, open, onToggle, actions }) {
  const meta = TYPE_META[item.type] || TYPE_META.post;
  const Icon = Icons[meta.icon] || Icons.Doc;
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <button type="button" onClick={onToggle} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', textAlign: 'left' }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={16} sw={1.8}/></span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 14.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{meta.label}{item.type === 'pdf' && item.fileName ? ` · ${item.fileName}` : ''}</span>
        </span>
        {actions}
        <Icons.Arrow size={14} stroke="var(--muted)" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', flexShrink: 0 }}/>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)', padding: 16 }}>
          {item.type === 'video' && item.youtubeId && (
            <div style={{ position: 'relative', paddingTop: '56.25%', borderRadius: 12, overflow: 'hidden', background: '#000' }}>
              <iframe title={item.title} src={`https://www.youtube-nocookie.com/embed/${item.youtubeId}?rel=0&modestbranding=1&playsinline=1`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowFullScreen
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}/>
            </div>
          )}
          {item.type === 'pdf' && item.fileUrl && (
            <div>
              <iframe title={item.title} src={item.fileUrl} style={{ width: '100%', height: '70vh', border: '1px solid var(--border)', borderRadius: 12, background: 'white' }}/>
              <a href={item.fileUrl} target="_blank" rel="noreferrer" className="btn btn-outline" style={{ marginTop: 10 }}><Icons.Doc size={13}/> Open PDF</a>
            </div>
          )}
          {item.type === 'post' && (
            <div style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--fg)' }}><MiniMarkdown text={item.body || ''}/></div>
          )}
          {item.body && item.type !== 'post' && (
            <div style={{ marginTop: 12, fontSize: 14, lineHeight: 1.6, color: 'var(--fg-2)' }}><MiniMarkdown text={item.body}/></div>
          )}
        </div>
      )}
    </div>
  );
}

export function ContentList({ items, renderActions }) {
  const [openId, setOpenId] = useState(null);
  if (!items.length) return <EmptyNote icon="Doc" title="No content yet" hint="Lessons, PDFs and videos will appear here."/>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it) => (
        <ContentItem key={it.id} item={it} open={openId === it.id} onToggle={() => setOpenId(openId === it.id ? null : it.id)}
          actions={renderActions ? renderActions(it) : null}/>
      ))}
    </div>
  );
}

// The members-only feed lives in CommunityFeed.jsx (reactions, photos,
// mentions, pinning, lesson comments). Re-exported here so every caller
// keeps importing { Community } from this file with the same props.
export { Community, LessonComments } from './CommunityFeed.jsx';
