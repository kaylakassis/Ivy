// Program community: the members-only feed and the comment threads under
// lessons. Same building blocks for both:
//   • composer with @mentions (program members only), photos (feed), and
//     for the coach: announcements
//   • posts with replies, reactions, a photo grid, pinning (coach, max 3),
//     editing for 15 minutes, report (members) and remove / mute (coach)
// <Community programId enabled/> keeps the props the old component had;
// <LessonComments programId itemId/> is mounted by the lesson view.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { MoreMenu, ReportModal } from '../../components/Moderation.jsx';
import { Avatar, ImageGrid, ago, uploadProgramImage, IMAGE_TYPES } from './communityUi.jsx';

export const REACTIONS = [
  { id: 'heart', emoji: '❤️', label: 'Love' },
  { id: 'clap', emoji: '👏', label: 'Applause' },
  { id: 'fire', emoji: '🔥', label: 'Fire' },
  { id: 'laugh', emoji: '😂', label: 'Funny' },
  { id: '100', emoji: '💯', label: 'Spot on' },
];
const KIND_META = { win: { label: 'Win', color: 'var(--ok)' }, question: { label: 'Question', color: 'var(--warn)' }, post: { label: 'Post', color: 'var(--muted)' } };
const MAX_IMAGES = 6;

export function Community({ programId, enabled = true }) {
  if (!enabled) return <EmptyNote icon="Users" title="Community is off" hint="Turn it on in the program settings to let members talk to each other."/>;
  return <Thread programId={programId}/>;
}

export function LessonComments({ programId, itemId }) {
  if (!programId || !itemId) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>Comments</div>
      <Thread programId={programId} itemId={itemId}/>
    </div>
  );
}

function Thread({ programId, itemId = null }) {
  const lesson = !!itemId;
  const [posts, setPosts] = useState(null);
  const [role, setRole] = useState(null);
  const [muted, setMuted] = useState(false);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState(null);
  const [replyingTo, setReplyingTo] = useState(null);
  const [mutedMembers, setMutedMembers] = useState([]);
  const base = `/programs/${programId}/posts${lesson ? `?itemId=${encodeURIComponent(itemId)}` : ''}`;
  const pageUrl = (c) => (c ? `${base}${lesson ? '&' : '?'}cursor=${encodeURIComponent(c)}` : base);

  const load = useCallback(async () => {
    try {
      const r = await api.get(pageUrl(null));
      setPosts(r.posts || []); setRole(r.role); setMuted(!!r.muted); setHasMore(!!r.hasMore); setCursor(r.nextCursor || null); setErr(null);
      if (r.role === 'owner' && !lesson) api.get(`/programs/${programId}/community`).then((s) => setMutedMembers(s.mutedMembers || [])).catch(() => {});
    } catch (e) { setErr(e.message); setPosts((p) => p || []); }
  }, [programId, itemId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setPosts(null); load(); }, [load]);

  const more = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await api.get(pageUrl(cursor));
      setPosts((cur) => { const seen = new Set(cur.map((p) => p.id)); return [...cur, ...(r.posts || []).filter((p) => !seen.has(p.id))]; });
      setHasMore(!!r.hasMore); setCursor(r.nextCursor || null);
    } catch (e) { setErr(e.message); } finally { setLoadingMore(false); }
  };

  const upsert = (post) => setPosts((cur) => { const i = cur.findIndex((p) => p.id === post.id); if (i === -1) return [post, ...cur]; const next = cur.slice(); next[i] = { ...cur[i], ...post }; return next; });
  const removeLocal = (id) => setPosts((cur) => cur.filter((p) => p.id !== id && p.parentId !== id));
  const mute = async (post, on) => {
    try {
      await api.post(`/programs/${programId}/community`, { action: on ? 'mute' : 'unmute', clientId: post.authorKey || post.clientId });
      const s = await api.get(`/programs/${programId}/community`); setMutedMembers(s.mutedMembers || []);
    } catch (e) { setErr(e.message); }
  };

  const ctx = { programId, role, muted, lesson, upsert, removeLocal, setErr, reload: load, mute, replyingTo, setReplyingTo, mutedKeys: new Set(mutedMembers.map((m) => m.clientId)) };
  const top = (posts || []).filter((p) => !p.parentId);
  const repliesOf = (id) => (posts || []).filter((p) => p.parentId === id).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {muted ? (
        <div className="card" style={{ padding: 14, fontSize: 13, color: 'var(--muted)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <Icons.EyeOff size={14}/> The coach has paused your posting here. You can still read along and react.
        </div>
      ) : role && (
        <div className="card" style={{ padding: 14 }}>
          <Composer programId={programId} itemId={itemId} role={role} mode={lesson ? 'lesson' : 'feed'} onPosted={(p) => upsert(p)}/>
        </div>
      )}
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      {posts === null ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        : top.length === 0 ? (lesson
          ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>No comments yet. Start the conversation.</div>
          : <EmptyNote icon="Users" title="Quiet so far" hint="Be the first to share a win or ask a question."/>)
        : top.map((p) => <PostCard key={p.id} post={p} replies={repliesOf(p.id)} ctx={ctx}/>)}
      {hasMore && (
        <button type="button" className="btn btn-outline" onClick={more} disabled={loadingMore} style={{ alignSelf: 'center' }}>{loadingMore ? 'Loading…' : 'Load more'}</button>
      )}
      {role === 'owner' && !lesson && mutedMembers.length > 0 && (
        <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Muted members</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>They can read and react, but not post.</div>
          {mutedMembers.map((m) => (
            <div key={m.clientId} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5 }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
              <button type="button" className="btn btn-ghost" style={{ fontSize: 12.5, padding: '4px 10px', minHeight: 30 }} onClick={() => mute({ clientId: m.clientId }, false)}>Unmute</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PostCard({ post, replies, ctx }) {
  const replying = ctx.replyingTo === post.id;
  return (
    <div className="card" style={{ padding: 14, borderColor: post.pinned ? 'var(--accent)' : undefined }}>
      {(post.pinned || post.isAnnouncement) && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 8, fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--accent)' }}>
          {post.pinned && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icons.Star size={11}/> Pinned</span>}
          {post.isAnnouncement && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icons.Bell size={11}/> Announcement</span>}
        </div>
      )}
      <PostRow post={post} ctx={ctx} top onReply={() => ctx.setReplyingTo(replying ? null : post.id)}/>
      {(replies.length > 0 || replying) && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12, paddingLeft: 12, borderLeft: '2px solid var(--border)', marginLeft: 16 }}>
          {replies.map((r) => <PostRow key={r.id} post={r} ctx={ctx}/>)}
          {replying && !ctx.muted && (
            <Composer programId={ctx.programId} itemId={post.itemId} parentId={post.id} role={ctx.role} mode="reply" autoFocus
              onPosted={(p) => { ctx.upsert(p); ctx.setReplyingTo(null); }} onCancel={() => ctx.setReplyingTo(null)}/>
          )}
        </div>
      )}
    </div>
  );
}

function PostRow({ post, ctx, top = false, onReply }) {
  const [editing, setEditing] = useState(false);
  const [reporting, setReporting] = useState(false);
  const isOwner = ctx.role === 'owner';
  const k = KIND_META[post.kind] || KIND_META.post;
  const feedTop = top && !ctx.lesson;
  const call = async (fn) => { try { await fn(); } catch (e) { ctx.setErr(e.message); } };
  const remove = () => call(async () => {
    if (!window.confirm(post.parentId ? 'Remove this reply?' : 'Remove this post and its replies?')) return;
    await api.del(`/programs/${ctx.programId}/posts?postId=${post.id}`); ctx.removeLocal(post.id);
  });
  const pin = (on) => call(async () => { await api.patch(`/programs/${ctx.programId}/posts`, { postId: post.id, pinned: on }); await ctx.reload(); });
  const announce = () => call(async () => {
    if (!window.confirm('Make this an announcement? Every member gets an email and a notification.')) return;
    const r = await api.patch(`/programs/${ctx.programId}/posts`, { postId: post.id, announce: true }); ctx.upsert(r.post);
  });
  const authorMuted = post.authorKey && ctx.mutedKeys.has(post.authorKey);
  const items = [
    post.canEdit && { label: 'Edit', onClick: () => setEditing(true) },
    feedTop && isOwner && { label: post.pinned ? 'Unpin' : 'Pin to top', onClick: () => pin(!post.pinned) },
    feedTop && isOwner && !post.isAnnouncement && { label: 'Make it an announcement', onClick: announce },
    isOwner && post.authorKey && post.authorKey !== 'owner' && { label: authorMuted ? `Unmute ${post.authorName}` : `Mute ${post.authorName}`, onClick: () => ctx.mute(post, !authorMuted) },
    !isOwner && !post.mine && { label: 'Report', onClick: () => setReporting(true), danger: true },
    (post.mine || isOwner) && { label: 'Remove', onClick: remove, danger: true },
  ].filter(Boolean);
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <Avatar name={post.authorName} url={post.authorAvatar} size={top ? 36 : 30}/>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
          <b style={{ color: 'var(--fg)', fontSize: 13.5 }}>{post.authorName}</b>
          {post.isOwner && <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--accent)' }}>Coach</span>}
          {top && !ctx.lesson && post.kind !== 'post' && <span style={{ fontSize: 11, fontWeight: 600, color: k.color }}>{k.label}</span>}
          <span>· {ago(post.createdAt)}{post.editedAt ? ' · edited' : ''}</span>
          {isOwner && post.reportCount > 0 && <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--danger)' }}>Reported</span>}
          <span style={{ marginLeft: 'auto' }}>{items.length > 0 && <MoreMenu items={items} label="Post options"/>}</span>
        </div>
        {editing ? (
          <EditBox post={post} ctx={ctx} onDone={() => setEditing(false)}/>
        ) : (
          post.body && <div style={{ marginTop: 4, fontSize: 14.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><MentionText text={post.body} mentions={post.mentions}/></div>
        )}
        <ImageGrid images={post.images}/>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <ReactionBar post={post} ctx={ctx}/>
          {onReply && !ctx.muted && <button type="button" onClick={onReply} style={{ color: 'var(--accent)', fontSize: 12.5, padding: '4px 6px', marginLeft: 'auto' }}>Reply</button>}
        </div>
      </div>
      {reporting && (
        <ReportModal title="Report this post" onClose={() => setReporting(false)}
          onSubmit={(reason, details) => api.post(`/programs/${ctx.programId}/community`, { action: 'report', postId: post.id, reason, details })}/>
      )}
    </div>
  );
}

function MentionText({ text, mentions }) {
  const names = (mentions || []).map((m) => m.name).filter(Boolean);
  if (!names.length) return text;
  const re = new RegExp(`(${names.map((n) => `@${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).join('|')})`, 'g');
  return String(text).split(re).map((part, i) => (i % 2 === 1
    ? <span key={i} style={{ color: 'var(--accent)', fontWeight: 600 }}>{part}</span>
    : <React.Fragment key={i}>{part}</React.Fragment>));
}

function ReactionBar({ post, ctx }) {
  const [state, setState] = useState(post.reactions || { counts: {}, mine: [] });
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => { setState(post.reactions || { counts: {}, mine: [] }); }, [post.reactions]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('touchstart', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('touchstart', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const toggle = async (id) => {
    setOpen(false);
    const had = state.mine.includes(id);
    const optimistic = { counts: { ...state.counts, [id]: Math.max(0, (state.counts[id] || 0) + (had ? -1 : 1)) }, mine: had ? state.mine.filter((x) => x !== id) : [...state.mine, id] };
    setState(optimistic);
    try { const r = await api.post(`/programs/${ctx.programId}/reactions`, { postId: post.id, emoji: id }); setState(r.reactions); }
    catch (e) { setState(state); ctx.setErr(e.message); }
  };
  const used = REACTIONS.filter((r) => (state.counts[r.id] || 0) > 0);
  const chip = (r, count) => {
    const mine = state.mine.includes(r.id);
    return (
      <button key={r.id} type="button" onClick={() => toggle(r.id)} aria-pressed={mine} aria-label={`${r.label}${count ? `, ${count}` : ''}`}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', minHeight: 28, borderRadius: 99, fontSize: 13, border: `1px solid ${mine ? 'var(--accent)' : 'var(--border)'}`, background: mine ? 'var(--accent-soft)' : 'transparent', color: 'var(--fg)' }}>
        <span>{r.emoji}</span>{count ? <span style={{ fontSize: 12, fontWeight: 600 }}>{count}</span> : null}
      </button>
    );
  };
  return (
    <div ref={boxRef} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', position: 'relative' }}>
      {used.map((r) => chip(r, state.counts[r.id]))}
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label="Add a reaction" aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 9px', minHeight: 28, borderRadius: 99, fontSize: 12.5, border: '1px solid var(--border)', color: 'var(--muted)' }}>
        <Icons.Heart size={12}/><Icons.Plus size={10} sw={2.2}/>
      </button>
      {open && (
        <div role="menu" className="card" style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 50, padding: 6, display: 'flex', gap: 4, boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.18))' }}>
          {REACTIONS.map((r) => (
            <button key={r.id} type="button" role="menuitem" onClick={() => toggle(r.id)} aria-label={r.label} title={r.label}
              style={{ fontSize: 20, padding: '4px 6px', borderRadius: 8, background: state.mine.includes(r.id) ? 'var(--accent-soft)' : 'transparent' }}>{r.emoji}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function EditBox({ post, ctx, onDone }) {
  const [body, setBody] = useState(post.body || '');
  const [mentions, setMentions] = useState(post.mentions || []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { const r = await api.patch(`/programs/${ctx.programId}/posts`, { postId: post.id, body, mentions: mentions.map((m) => m.key) }); ctx.upsert(r.post); onDone(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <MentionInput programId={ctx.programId} value={body} onChange={setBody} onMention={(m) => setMentions((c) => [...c.filter((x) => x.key !== m.key), m])} rows={3} autoFocus/>
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-ghost" onClick={onDone}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy || (!body.trim() && !(post.images || []).length)}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

// Textarea that suggests program members after "@".
function MentionInput({ programId, value, onChange, onMention, placeholder, rows = 3, autoFocus }) {
  const ref = useRef(null);
  const [query, setQuery] = useState(null);
  const [options, setOptions] = useState([]);
  const [active, setActive] = useState(0);
  const timer = useRef(null);
  const detect = (text, caret) => {
    const m = text.slice(0, caret).match(/(^|\s)@([^\s@]{0,30})$/);
    setQuery(m ? m[2] : null);
  };
  useEffect(() => {
    if (query == null) { setOptions([]); return undefined; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.get(`/programs/${programId}/directory?view=mentionables&q=${encodeURIComponent(query)}`).then((r) => { setOptions(r.members || []); setActive(0); }).catch(() => setOptions([]));
    }, 150);
    return () => clearTimeout(timer.current);
  }, [query, programId]);
  const pick = (opt) => {
    const el = ref.current;
    const caret = el ? el.selectionStart : value.length;
    const before = value.slice(0, caret).replace(/@([^\s@]{0,30})$/, `@${opt.name} `);
    const next = before + value.slice(caret);
    onChange(next); onMention(opt); setQuery(null); setOptions([]);
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(before.length, before.length); } });
  };
  const onKeyDown = (e) => {
    if (!options.length || query == null) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % options.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + options.length) % options.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(options[active]); }
    else if (e.key === 'Escape') { setQuery(null); }
  };
  return (
    <div style={{ position: 'relative' }}>
      <textarea ref={ref} className="input" rows={rows} value={value} placeholder={placeholder} autoFocus={autoFocus}
        onChange={(e) => { onChange(e.target.value); detect(e.target.value, e.target.selectionStart); }}
        onClick={(e) => detect(e.target.value, e.target.selectionStart)} onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setQuery(null), 150)} style={{ resize: 'vertical', width: '100%' }}/>
      {query != null && options.length > 0 && (
        <div role="listbox" className="card" style={{ position: 'absolute', left: 0, right: 0, top: 'calc(100% + 4px)', zIndex: 60, padding: 4, maxHeight: 240, overflowY: 'auto', boxShadow: 'var(--shadow-md, 0 8px 24px rgba(0,0,0,0.18))' }}>
          {options.map((o, i) => (
            <button key={o.key} type="button" role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(o); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 8, fontSize: 13.5, background: i === active ? 'var(--surface-2)' : 'transparent' }}>
              <Avatar name={o.name} size={22}/> <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</span>
              {o.key === 'owner' && <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Coach</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({ programId, itemId = null, parentId = null, role, mode, onPosted, onCancel, autoFocus }) {
  const isOwner = role === 'owner';
  const [kind, setKind] = useState(isOwner ? 'post' : 'win');
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState([]);
  const [images, setImages] = useState([]);
  const [announce, setAnnounce] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);
  const feed = mode === 'feed';
  const placeholder = mode === 'reply' ? 'Write a reply…'
    : mode === 'lesson' ? 'Ask a question or share a thought about this lesson…'
    : kind === 'win' ? 'What did you accomplish?' : kind === 'question' ? 'What do you want to know?' : 'Share something with the group…';
  const kinds = useMemo(() => (isOwner ? [['post', 'Post'], ['question', 'Question'], ['win', 'Win']] : [['win', 'Share a win'], ['question', 'Ask a question'], ['post', 'Post']]), [isOwner]);
  const addFiles = async (files) => {
    const list = Array.from(files || []).slice(0, MAX_IMAGES - images.length);
    if (!list.length) return;
    setUploading(true); setErr(null);
    try {
      for (const f of list) { const url = await uploadProgramImage(f); setImages((cur) => (cur.length < MAX_IMAGES ? [...cur, url] : cur)); }
    } catch (e) { setErr(e.message || 'Upload failed'); } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!body.trim() && !images.length) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/programs/${programId}/posts`, {
        kind: feed ? kind : 'post', body: body.trim(), parentId, itemId, images,
        mentions: mentions.filter((m) => body.includes(`@${m.name}`)).map((m) => m.key),
        announce: feed && isOwner && announce,
      });
      setBody(''); setMentions([]); setImages([]); setAnnounce(false);
      onPosted?.(r.post);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {feed && (
        <div className="scroll-x" style={{ display: 'flex', gap: 6 }}>
          {kinds.map(([k, l]) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={`btn ${kind === k ? 'btn-primary' : 'btn-outline'}`} style={{ padding: '6px 12px', fontSize: 12.5, minHeight: 34, whiteSpace: 'nowrap' }}>{l}</button>
          ))}
        </div>
      )}
      <MentionInput programId={programId} value={body} onChange={setBody} placeholder={placeholder} rows={mode === 'reply' ? 2 : 3} autoFocus={autoFocus}
        onMention={(m) => setMentions((c) => [...c.filter((x) => x.key !== m.key), m])}/>
      {images.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {images.map((u) => (
            <span key={u} style={{ position: 'relative', width: 64, height: 64, borderRadius: 10, overflow: 'hidden', background: 'var(--surface-2)' }}>
              <img src={u} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
              <button type="button" aria-label="Remove photo" onClick={() => setImages((c) => c.filter((x) => x !== u))} style={{ position: 'absolute', top: 2, right: 2, width: 22, height: 22, borderRadius: 99, background: 'rgba(0,0,0,.6)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icons.X size={12}/></button>
            </span>
          ))}
        </div>
      )}
      {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {feed && (
          <label className="btn btn-ghost" style={{ cursor: images.length >= MAX_IMAGES ? 'default' : 'pointer', padding: '6px 10px', fontSize: 12.5, opacity: images.length >= MAX_IMAGES ? 0.5 : 1 }} aria-label="Add photos">
            <Icons.Image size={14}/> {uploading ? 'Uploading…' : 'Photos'}
            <input ref={fileRef} type="file" accept={IMAGE_TYPES} multiple hidden disabled={uploading || images.length >= MAX_IMAGES} onChange={(e) => addFiles(e.target.files)}/>
          </label>
        )}
        {feed && isOwner && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--fg-2)' }}>
            <input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)}/> Announcement (emails everyone)
          </label>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
          <button type="submit" className="btn btn-primary" disabled={busy || uploading || (!body.trim() && !images.length)}>{busy ? 'Posting…' : mode === 'reply' ? 'Reply' : mode === 'lesson' ? 'Comment' : 'Post'}</button>
        </span>
      </div>
    </form>
  );
}
