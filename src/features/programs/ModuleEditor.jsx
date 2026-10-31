// Owner: the Content tab of a program. Modules (sections / weeks) with an
// optional unlock day, lessons inside them, and the lesson editor (written
// lessons, YouTube / Vimeo / Loom links or uploaded videos, audio, PDFs,
// image galleries, downloads, free previews).
import React, { useState } from 'react';
import { api } from '../../lib/api.js';
import { Icons } from '../../components/Icons.jsx';
import { groupLessons } from './CourseOutline.jsx';
import { Sheet, Field, lessonMeta, uploadProgramFile, UPLOAD_LIMITS, fmtSize } from './courseUi.jsx';

const small = { padding: 6, color: 'var(--muted)', fontSize: 12.5, minWidth: 30, minHeight: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };

export default function ModuleEditor({ programId, program, items, modules, activeMembers = 0, reload, onError }) {
  const [moduleForm, setModuleForm] = useState(null); // {} new | module
  const [lessonForm, setLessonForm] = useState(null); // { moduleId } new | { item }
  const groups = groupLessons(items, modules);
  if (modules.length && !groups.some((g) => !g.module)) groups.unshift({ module: null, lessons: [] });
  const run = async (fn) => { try { await fn(); await reload(); } catch (e) { onError?.(e.message); } };

  const moveModule = (m, dir) => run(async () => {
    const order = modules.map((x) => x.id); const i = order.indexOf(m.id); const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    await api.patch(`/programs/${programId}/modules`, { order });
  });
  const removeModule = (m) => {
    if (!window.confirm(`Delete the module "${m.title}"? Its lessons are kept and move to the top of the program.`)) return;
    run(() => api.del(`/programs/${programId}/modules?moduleId=${m.id}`));
  };
  const moveLesson = (group, it, dir) => run(async () => {
    const order = group.lessons.map((x) => x.id); const i = order.indexOf(it.id); const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    await api.patch(`/programs/${programId}/items`, { order, moduleId: group.module ? group.module.id : null });
  });
  const toModule = (it, moduleId) => run(() => api.patch(`/programs/${programId}/items`, { itemId: it.id, moduleId: moduleId || null }));
  const removeLesson = (it) => {
    if (!window.confirm(`Remove "${it.title}"? Members keep their access; only this lesson goes away.`)) return;
    run(() => api.del(`/programs/${programId}/items?itemId=${it.id}`));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button className="btn btn-outline" onClick={() => setModuleForm({})}><Icons.Folder size={13}/> Add module</button>
        <button className="btn btn-primary" onClick={() => setLessonForm({ moduleId: null })}><Icons.Plus size={13} sw={2}/> Add lesson</button>
      </div>
      {!items.length && !modules.length && (
        <div className="card" style={{ padding: 22, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Build your course</div>
          <div style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.5 }}>Group lessons into modules (like weeks or sections), then add written lessons, videos, audio and downloads. You can drip a module so it opens a set number of days after someone joins.</div>
        </div>
      )}
      {groups.map((g) => {
        const m = g.module;
        return (
          <section key={m?.id || 'top'} className="card" style={{ padding: 4 }}>
            <div style={{ padding: '10px 12px 6px', display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                {m ? <>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{m.title}</div>
                  {m.description && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{m.description}</div>}
                  <div style={{ fontSize: 12, color: m.unlockAfterDays ? 'var(--fg-2)' : 'var(--muted)', marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    {program?.delivery === 'cohort' && m.availableBeforeStart ? 'Open before the cohort starts'
                      : m.unlockAfterDays ? <><Icons.Lock size={12}/> Opens {m.unlockAfterDays} day{m.unlockAfterDays === 1 ? '' : 's'} after {program?.delivery === 'cohort' ? 'the cohort starts' : 'a member joins'}</>
                      : program?.delivery === 'cohort' ? 'Opens on the start date' : 'Open from the start'}
                  </div>
                </> : (
                  <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--muted)', paddingTop: 2 }}>{modules.length ? 'Not in a module' : 'Lessons'}</div>
                )}
              </div>
              <span style={{ display: 'inline-flex', gap: 2, flexWrap: 'wrap' }}>
                {m && <>
                  <button type="button" aria-label="Move module up" disabled={modules.indexOf(m) === 0} onClick={() => moveModule(m, -1)} style={small}>↑</button>
                  <button type="button" aria-label="Move module down" disabled={modules.indexOf(m) === modules.length - 1} onClick={() => moveModule(m, 1)} style={small}>↓</button>
                  <button type="button" aria-label={`Edit module ${m.title}`} onClick={() => setModuleForm(m)} style={small}>Edit</button>
                  <button type="button" aria-label={`Delete module ${m.title}`} onClick={() => removeModule(m)} style={small}>Delete</button>
                </>}
                <button type="button" aria-label={m ? `Add a lesson to ${m.title}` : 'Add a lesson'} onClick={() => setLessonForm({ moduleId: m ? m.id : null })} style={{ ...small, color: 'var(--accent)', fontWeight: 600 }}><Icons.Plus size={12} sw={2}/> Lesson</button>
              </span>
            </div>
            {g.lessons.length === 0 && <div style={{ padding: '2px 12px 12px', fontSize: 12.5, color: 'var(--muted)' }}>{m ? 'No lessons in this module yet.' : 'Lessons here show before the first module.'}</div>}
            {g.lessons.map((it, i) => {
              const meta = lessonMeta(it.type); const Icon = meta.icon;
              return (
                <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
                  <span style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon size={14}/></span>
                  <button type="button" onClick={() => setLessonForm({ item: it })} style={{ flex: 1, minWidth: 150, textAlign: 'left', color: 'inherit' }}>
                    <span style={{ display: 'block', fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {meta.label}{it.isPreview ? ' · Free preview' : ''} · {it.completedCount || 0} of {activeMembers} completed
                    </span>
                  </button>
                  <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center', marginLeft: 'auto' }}>
                    <button type="button" aria-label="Move lesson up" disabled={i === 0} onClick={() => moveLesson(g, it, -1)} style={small}>↑</button>
                    <button type="button" aria-label="Move lesson down" disabled={i === g.lessons.length - 1} onClick={() => moveLesson(g, it, 1)} style={small}>↓</button>
                    {modules.length > 0 && (
                      <select aria-label="Move to module" className="input" value={it.moduleId || ''} onChange={(e) => toModule(it, e.target.value)} style={{ width: 120, padding: '4px 6px', fontSize: 12, minHeight: 30 }}>
                        <option value="">No module</option>
                        {modules.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
                      </select>
                    )}
                    <button type="button" onClick={() => removeLesson(it)} style={small} aria-label={`Remove ${it.title}`}><Icons.Trash size={14}/></button>
                  </span>
                </div>
              );
            })}
          </section>
        );
      })}
      {moduleForm && <ModuleForm programId={programId} cohort={program?.delivery === 'cohort'} module={moduleForm.id ? moduleForm : null} onClose={() => setModuleForm(null)} onSaved={() => { setModuleForm(null); reload(); }}/>}
      {lessonForm && <LessonForm programId={programId} program={program} modules={modules} item={lessonForm.item} moduleId={lessonForm.moduleId}
        activeMembers={activeMembers} onClose={() => setLessonForm(null)} onSaved={() => { setLessonForm(null); reload(); }}/>}
    </div>
  );
}

function ModuleForm({ programId, module, cohort = false, onClose, onSaved }) {
  const [f, setF] = useState({ title: module?.title || '', description: module?.description || '', unlockAfterDays: module?.unlockAfterDays ? String(module.unlockAfterDays) : '', availableBeforeStart: !!module?.availableBeforeStart });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const payload = { title: f.title, description: f.description, unlockAfterDays: f.unlockAfterDays === '' ? null : Number(f.unlockAfterDays), availableBeforeStart: !!f.availableBeforeStart };
    try {
      if (module) await api.patch(`/programs/${programId}/modules`, { moduleId: module.id, ...payload });
      else await api.post(`/programs/${programId}/modules`, payload);
      onSaved();
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  return (
    <Sheet title={module ? 'Edit module' : 'New module'} onClose={onClose} width={480}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Week 1: Getting started" autoFocus required maxLength={140}/></Field>
        <Field label="Description (optional)"><textarea className="input" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} style={{ resize: 'vertical' }}/></Field>
        {!(cohort && f.availableBeforeStart) && (
          <Field label="Unlocks after (days)" hint={cohort ? 'Leave blank to open it on the cohort start date. Otherwise it opens this many days after the cohort starts, and members get an email when it does.' : 'Leave blank to open it right away. Otherwise it opens this many days after each member joins, and they get an email when it does.'}>
            <input className="input" type="number" min="0" max="3650" inputMode="numeric" value={f.unlockAfterDays} onChange={(e) => setF({ ...f, unlockAfterDays: e.target.value })} placeholder={cohort ? 'On the start date' : 'Right away'}/>
          </Field>
        )}
        {cohort && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 14 }}>
            <input type="checkbox" checked={f.availableBeforeStart} onChange={(e) => setF({ ...f, availableBeforeStart: e.target.checked })} style={{ marginTop: 3 }}/>
            <span>Open before the cohort starts<span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>For welcome or getting-ready content members can see as soon as they join.</span></span>
          </label>
        )}
        {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || !f.title.trim()}>{busy ? 'Saving…' : 'Save'}</button></div>
      </form>
    </Sheet>
  );
}

const TYPES = [['post', 'Written'], ['video', 'Video'], ['audio', 'Audio'], ['pdf', 'PDF']];

function LessonForm({ programId, program, modules, item, moduleId, activeMembers, onClose, onSaved }) {
  const [type, setType] = useState(item?.type || 'post');
  const [f, setF] = useState(() => ({
    title: item?.title || '', body: item?.body || '', moduleId: item ? (item.moduleId || '') : (moduleId || ''),
    videoSource: item?.type === 'video' && item.videoProvider === 'upload' ? 'upload' : 'link',
    videoUrl: item?.videoUrl || (item?.youtubeId ? `https://youtu.be/${item.youtubeId}` : ''),
    mediaUrl: item?.mediaUrl || null, mediaName: item?.mediaName || null,
    fileUrl: item?.fileUrl || null, fileName: item?.fileName || null,
    images: item?.images || [], attachments: item?.attachments || [], isPreview: !!item?.isPreview, notify: true,
  }));
  const [busy, setBusy] = useState(false); const [uploading, setUploading] = useState(null); const [err, setErr] = useState(null);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));

  const up = async (file, kind, label) => {
    setUploading({ label, pct: 0 }); setErr(null);
    try { return await uploadProgramFile(file, kind, (pct) => setUploading({ label, pct })); }
    finally { setUploading(null); }
  };
  const pickMain = async (file, kind) => {
    if (!file) return;
    try {
      const b = await up(file, kind, file.name);
      if (kind === 'default') set({ fileUrl: b.url, fileName: file.name, title: f.title || file.name.replace(/\.pdf$/i, '') });
      else set({ mediaUrl: b.url, mediaName: file.name, title: f.title || file.name.replace(/\.[a-z0-9]+$/i, '') });
    } catch (ex) { setErr(ex.message || 'Upload failed'); }
  };
  const pickImages = async (files) => {
    const list = Array.from(files || []).slice(0, Math.max(0, 10 - f.images.length));
    for (const file of list) {
      try {
         
        const b = await up(file, 'image', file.name);
        setF((x) => ({ ...x, images: [...x.images, { url: b.url, name: file.name }].slice(0, 10) }));
      } catch (ex) { setErr(ex.message || 'Upload failed'); break; }
    }
  };
  const pickAttachments = async (files) => {
    const list = Array.from(files || []).slice(0, Math.max(0, 5 - f.attachments.length));
    for (const file of list) {
      try {
         
        const b = await up(file, 'attachment', file.name);
        setF((x) => ({ ...x, attachments: [...x.attachments, { url: b.url, name: file.name, size: file.size }].slice(0, 5) }));
      } catch (ex) { setErr(ex.message || 'Upload failed'); break; }
    }
  };

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const payload = {
      type, title: f.title, body: f.body, moduleId: f.moduleId || null, isPreview: f.isPreview, images: f.images, attachments: f.attachments,
      fileUrl: type === 'pdf' ? f.fileUrl : null, fileName: type === 'pdf' ? f.fileName : null,
      mediaUrl: (type === 'audio' || (type === 'video' && f.videoSource === 'upload')) ? f.mediaUrl : null,
      mediaName: (type === 'audio' || (type === 'video' && f.videoSource === 'upload')) ? f.mediaName : null,
      videoUrl: type === 'video' && f.videoSource === 'link' ? f.videoUrl : '',
    };
    try {
      if (item) await api.patch(`/programs/${programId}/items`, { itemId: item.id, ...payload });
      else await api.post(`/programs/${programId}/items`, { ...payload, notify: f.notify });
      onSaved();
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  const needsMain = (type === 'pdf' && !f.fileUrl) || (type === 'audio' && !f.mediaUrl) || (type === 'video' && f.videoSource === 'upload' && !f.mediaUrl) || (type === 'video' && f.videoSource === 'link' && !f.videoUrl.trim());
  const uploadBtn = (label, accept, onPick, multiple = false) => (
    <label className="btn btn-outline" style={{ cursor: uploading ? 'wait' : 'pointer', alignSelf: 'flex-start' }}>
      <Icons.Paperclip size={13}/> {label}
      <input type="file" accept={accept} multiple={multiple} hidden disabled={!!uploading} onChange={(e) => { onPick(multiple ? e.target.files : e.target.files?.[0]); e.target.value = ''; }}/>
    </label>
  );

  return (
    <Sheet title={item ? 'Edit lesson' : 'New lesson'} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {!item && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
            {TYPES.map(([t, l]) => <button key={t} type="button" onClick={() => setType(t)} className={`btn ${type === t ? 'btn-primary' : 'btn-outline'}`} style={{ justifyContent: 'center', padding: '8px 4px', fontSize: 13 }}>{l}</button>)}
          </div>
        )}
        <Field label="Title"><input className="input" value={f.title} onChange={(e) => set({ title: e.target.value })} required autoFocus maxLength={200}/></Field>
        {modules.length > 0 && (
          <Field label="Module">
            <select className="input" value={f.moduleId} onChange={(e) => set({ moduleId: e.target.value })}>
              <option value="">No module (shows first)</option>
              {modules.map((m) => <option key={m.id} value={m.id}>{m.title}{m.unlockAfterDays ? ` (opens day ${m.unlockAfterDays})` : ''}</option>)}
            </select>
          </Field>
        )}
        {type === 'video' && (
          <Field label="Video">
            <div style={{ display: 'flex', gap: 6 }}>
              {[['link', 'Paste a link'], ['upload', 'Upload a file']].map(([k, l]) => (
                <button key={k} type="button" onClick={() => set({ videoSource: k })} className={`btn ${f.videoSource === k ? 'btn-primary' : 'btn-outline'}`} style={{ flex: 1, justifyContent: 'center', fontSize: 13, padding: '7px 8px' }}>{l}</button>
              ))}
            </div>
            {f.videoSource === 'link' ? (
              <input className="input" value={f.videoUrl} onChange={(e) => set({ videoUrl: e.target.value })} placeholder="https://youtu.be/… or a Vimeo or Loom link" inputMode="url" autoCapitalize="off"/>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {uploadBtn(f.mediaUrl ? 'Replace video' : 'Choose video', UPLOAD_LIMITS.video.accept, (file) => pickMain(file, 'video'))}
                {f.mediaName && <span style={{ fontSize: 13, color: 'var(--fg-2)', overflowWrap: 'anywhere' }}>{f.mediaName}</span>}
              </div>
            )}
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{f.videoSource === 'link' ? 'YouTube, Vimeo or Loom. Unlisted videos work. It plays inside Ivy.' : 'MP4, MOV or WebM, up to 500 MB.'}</span>
          </Field>
        )}
        {type === 'audio' && (
          <Field label="Audio file" hint="MP3, M4A or WAV, up to 100 MB.">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {uploadBtn(f.mediaUrl ? 'Replace audio' : 'Choose audio', UPLOAD_LIMITS.audio.accept, (file) => pickMain(file, 'audio'))}
              {f.mediaName && <span style={{ fontSize: 13, color: 'var(--fg-2)', overflowWrap: 'anywhere' }}>{f.mediaName}</span>}
            </div>
          </Field>
        )}
        {type === 'pdf' && (
          <Field label="PDF file" hint="Up to 25 MB.">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {uploadBtn(f.fileUrl ? 'Replace PDF' : 'Choose PDF', 'application/pdf', (file) => pickMain(file, 'default'))}
              {f.fileName && <span style={{ fontSize: 13, color: 'var(--fg-2)', overflowWrap: 'anywhere' }}>{f.fileName}</span>}
            </div>
          </Field>
        )}
        <Field label={type === 'post' ? 'Lesson' : 'Written part (optional)'} hint="Plain text with **bold**, *italics* and lists.">
          <textarea className="input" rows={type === 'post' ? 9 : 4} value={f.body} onChange={(e) => set({ body: e.target.value })} style={{ resize: 'vertical' }} required={type === 'post'}/>
        </Field>
        <Field label={`Images (${f.images.length}/10)`}>
          {f.images.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: 6 }}>
              {f.images.map((img) => (
                <div key={img.url} style={{ position: 'relative', aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
                  <img src={img.url} alt={img.name || ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
                  <button type="button" aria-label={`Remove ${img.name || 'image'}`} onClick={() => set({ images: f.images.filter((x) => x.url !== img.url) })}
                    style={{ position: 'absolute', top: 3, right: 3, width: 24, height: 24, borderRadius: 999, background: 'rgba(0,0,0,.6)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icons.X size={12} stroke="#fff"/></button>
                </div>
              ))}
            </div>
          )}
          {f.images.length < 10 && uploadBtn('Add images', UPLOAD_LIMITS.image.accept, pickImages, true)}
        </Field>
        <Field label={`Downloads (${f.attachments.length}/5)`} hint="Workbooks, worksheets, templates. Up to 50 MB each.">
          {f.attachments.map((a) => (
            <div key={a.url} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <Icons.Paperclip size={13} stroke="var(--muted)"/>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
              {a.size ? <span style={{ color: 'var(--muted)', fontSize: 12 }}>{fmtSize(a.size)}</span> : null}
              <button type="button" onClick={() => set({ attachments: f.attachments.filter((x) => x.url !== a.url) })} style={{ color: 'var(--muted)', fontSize: 12.5 }}>Remove</button>
            </div>
          ))}
          {f.attachments.length < 5 && uploadBtn('Add files', UPLOAD_LIMITS.attachment.accept, pickAttachments, true)}
        </Field>
        {uploading && <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>Uploading {uploading.label}… {uploading.pct ? `${uploading.pct}%` : ''}</div>}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 14 }}>
          <input type="checkbox" checked={f.isPreview} onChange={(e) => set({ isPreview: e.target.checked })} style={{ marginTop: 3 }}/>
          <span>Free preview<span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>Anyone can open this lesson on your sales page as a sample.</span></span>
        </label>
        {!item && program?.status === 'published' && (
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 14 }}>
            <input type="checkbox" checked={f.notify} onChange={(e) => set({ notify: e.target.checked })} style={{ marginTop: 3 }}/>
            <span>Notify members<span style={{ display: 'block', fontSize: 12, color: 'var(--muted)' }}>{activeMembers ? `Email and notify ${activeMembers} member${activeMembers === 1 ? '' : 's'} who can open it now.` : 'Members who can open it get an email and a notification.'}</span></span>
          </label>
        )}
        {err && <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !!uploading || needsMain || !f.title.trim()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Sheet>
  );
}
