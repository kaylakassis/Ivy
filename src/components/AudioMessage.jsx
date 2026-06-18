// Shared building blocks for voice messages across the messaging surfaces
// (owner 1:1, owner group chat, client DMs, client group chat).
//
// AudioPlayer  - inline player rendered inside a message bubble.
// RecordingBar - full-width composer state shown while recording.
//
// Both were originally inlined in Messages.jsx (owner 1:1). Extracting
// them here lets every other thread renderer/composer use the exact
// same visual + interaction model without copy-pasting the styling
// (and drifting from it later).
import React from 'react';

// Renders a native <audio> control sized to the bubble, plus a
// duration chip if the attachment carries one. `mine` flips colors so
// the control is readable both against the accent-colored "my message"
// bubble and the surface-colored "their message" bubble.
export function AudioPlayer({ url, mine, durationMs }) {
  const totalSec = durationMs ? Math.round(durationMs / 1000) : 0;
  const m = Math.floor(totalSec / 60);
  const s = String(totalSec % 60).padStart(2, '0');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 200 }}>
      <audio controls preload="metadata" src={url} style={{
        flex: 1, height: 36,
        // Chromium respects accentColor on native controls; Safari uses
        // its own appearance so this is a no-op there but harmless.
        accentColor: mine ? 'var(--accent-ink)' : 'var(--accent)',
      }}/>
      {totalSec > 0 && (
        <span className="mono-num" style={{
          fontSize: 11, opacity: 0.85,
          color: mine ? 'var(--accent-ink)' : 'var(--muted)',
        }}>
          {m}:{s}
        </span>
      )}
    </div>
  );
}

// True when an attachment object should be rendered with AudioPlayer
// rather than as a generic file link.
export function isAudioAttachment(att) {
  return !!att && (att.type || '').startsWith('audio/');
}

// Red-tinted composer replacement while recording. Shows elapsed time,
// the live transcript (so the user can see what's been captured), and
// Cancel / Send buttons.
export function RecordingBar({ elapsedMs, transcript, onSend, onCancel, sending }) {
  const sec = Math.floor(elapsedMs / 1000);
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px', borderRadius: 14,
      background: 'color-mix(in srgb, var(--danger) 6%, var(--surface-2))',
      border: '1px solid color-mix(in srgb, var(--danger) 35%, var(--border-strong))',
    }}>
      <span style={{
        width: 10, height: 10, borderRadius: 999, background: 'var(--danger)',
        animation: 'msg-mic-pulse 1.2s ease-in-out infinite',
        flex: '0 0 auto',
      }}/>
      <span className="mono-num" style={{
        fontSize: 13, fontWeight: 600, color: 'var(--fg)', flex: '0 0 auto',
      }}>
        {m}:{s}
      </span>
      <span style={{
        flex: 1, minWidth: 0, fontSize: 13, color: 'var(--muted)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {transcript || 'Recording…'}
      </span>
      <button type="button" onClick={onCancel} disabled={sending}
        className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }}>
        Cancel
      </button>
      <button type="button" onClick={onSend} disabled={sending}
        className="btn btn-primary" style={{ fontSize: 12, padding: '6px 14px' }}>
        {sending ? 'Sending…' : 'Send'}
      </button>
    </div>
  );
}

// Circular mic icon button - used to start a recording from a composer.
// Sized to match the other composer-icon buttons (Plus, Phone, etc.)
// already in use across the surfaces.
export function MicButton({ onClick, title = 'Record voice message', disabled }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      disabled={disabled}
      style={{
        flex: '0 0 auto',
        width: 38, height: 38, borderRadius: 999,
        border: '1px solid var(--border)',
        background: 'var(--surface)',
        color: 'var(--fg-2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="3" width="6" height="12" rx="3"/>
        <path d="M5 11a7 7 0 0 0 14 0"/>
        <path d="M12 18v3"/>
      </svg>
    </button>
  );
}

// Upload a recorded blob to Vercel Blob via the existing
// /api/messages/upload-token endpoint, then return an attachment object
// in the shape the messaging APIs already accept ({ url, type, name,
// durationMs }). Centralised here so the four composer integrations
// don't drift on file naming or extension logic.
//
// `upload` is the @vercel/blob/client function - passed in by the
// caller so this module doesn't need to import it directly (keeps the
// dependency surface explicit at call sites).
export async function uploadVoiceMemo(upload, { blob, mime, durationMs }, prefix = 'voice') {
  const ext = mime.includes('mp4') ? 'm4a'
            : mime.includes('ogg') ? 'ogg'
            : mime.includes('mpeg') ? 'mp3'
            : 'webm';
  const path = `messages/${prefix}-${Date.now()}.${ext}`;
  const uploaded = await upload(path, blob, {
    access: 'public',
    handleUploadUrl: '/api/messages/upload-token',
    contentType: mime,
  });
  return {
    url: uploaded.url,
    type: mime,
    name: 'Voice message',
    durationMs,
  };
}
