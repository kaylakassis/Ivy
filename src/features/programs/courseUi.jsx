// Small shared pieces for the course screens (owner editor, member
// outline, lesson view, sales page): a bottom sheet, a progress bar,
// two icons the main set does not have, and the uploader.
import React, { useEffect } from 'react';
import { uploadFile } from '../../lib/blobUpload.js';
import { Icons } from '../../components/Icons.jsx';

const Svg = ({ size = 16, children, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...rest}>{children}</svg>
);
export const PlayIcon = (p) => <Svg {...p}><path d="M7 4.5v15l12.5-7.5L7 4.5z"/></Svg>;
export const AudioIcon = (p) => <Svg {...p}><path d="M4 14v-2a8 8 0 0116 0v2"/><rect x="3" y="14" width="4.5" height="6.5" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="6.5" rx="1.5"/></Svg>;

export const LESSON_META = {
  post:  { icon: (p) => <Icons.Doc {...p}/>,  label: 'Lesson' },
  video: { icon: (p) => <PlayIcon {...p}/>,   label: 'Video' },
  audio: { icon: (p) => <AudioIcon {...p}/>,  label: 'Audio' },
  pdf:   { icon: (p) => <Icons.FileIcon {...p}/>, label: 'PDF' },
};
export const lessonMeta = (t) => LESSON_META[t] || LESSON_META.post;

export const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
export const fmtShort = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function ProgressBar({ percent = 0, height = 6, label }) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p} aria-label={label || 'Progress'}
      style={{ height, borderRadius: 999, background: 'var(--surface-2, var(--border))', overflow: 'hidden', width: '100%' }}>
      <div style={{ width: `${p}%`, height: '100%', background: 'var(--accent)', borderRadius: 999, transition: 'width .3s ease' }}/>
    </div>
  );
}

export function Field({ label, children, hint }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg-2)' }}>{label}</span>{children}{hint && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{hint}</span>}</label>;
}

export function Sheet({ title, onClose, children, width = 560 }) {
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 12 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: '100%', maxWidth: width, maxHeight: '92vh', overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, fontSize: 18, fontWeight: 600 }}>{title}</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ padding: 6, color: 'var(--muted)', display: 'inline-flex' }}><Icons.X size={18}/></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Upload kinds and caps mirror api/programs/upload-token.js.
export const UPLOAD_LIMITS = {
  video: { mb: 500, accept: 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm' },
  audio: { mb: 100, accept: 'audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav,.mp3,.m4a,.wav' },
  image: { mb: 25, accept: 'image/jpeg,image/png,image/webp,image/gif' },
  attachment: { mb: 50, accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.epub,image/*' },
  default: { mb: 25, accept: 'application/pdf' },
};

export async function uploadProgramFile(file, kind = 'default', onProgress) {
  const lim = UPLOAD_LIMITS[kind] || UPLOAD_LIMITS.default;
  if (file.size > lim.mb * 1024 * 1024) throw new Error(`That file is over ${lim.mb} MB.`);
  const safe = String(file.name || 'file').replace(/[^A-Za-z0-9._-]+/g, '-').slice(-80);
  return uploadFile(`programs/${Date.now()}-${safe}`, file, {
    access: 'public', handleUploadUrl: '/api/programs/upload-token',
    ...(kind !== 'default' ? { clientPayload: JSON.stringify({ kind }) } : {}),
    ...(kind === 'video' || file.size > 50 * 1024 * 1024 ? { multipart: true } : {}),
    ...(onProgress ? { onUploadProgress: (e) => onProgress(Math.round(e.percentage || 0)) } : {}),
  });
}

export const fmtSize = (n) => (!n ? '' : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
