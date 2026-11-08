// One appointment from the copy saved on this phone, opened with no signal.
// Everything a mobile pro needs on the doorstep: who, what, when, where
// (tap for directions), phone (tap to call), the notes, the video link.
// Two things can be done offline and are sent when signal returns: mark it
// complete, and add a short private note. Everything else waits.
import React, { useState } from 'react';
import Drawer from '../../features/calendar/Drawer.jsx';
import { Icons } from '../Icons.jsx';
import { minToHM } from '../../features/calendar/utils.js';
import { parseDateOnly } from '../../lib/dateOnly.js';
import { safeHref } from '../../lib/safeHref.js';
import { telHref, mapsHref, phoneForBooking } from '../../lib/offlineLinks.js';
import { enqueueOfflineAction, queuedFor } from '../../lib/offlineQueue.js';
import { patchSnapshotBooking } from '../../lib/snapshot.js';
import { useSnapshot } from '../../lib/useOffline.js';
import { haptic } from '../../lib/celebrate.js';

export const QUEUED_MESSAGE = "Saved on your phone. Ivy will send it when you have signal.";
export const OTHER_CHANGES_MESSAGE = "You're offline. Other changes can wait until you have signal.";

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border)', fontSize: 13.5 }}>
      <span style={{ width: 84, flexShrink: 0, color: 'var(--muted)', fontSize: 12.5 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{children}</span>
    </div>
  );
}

const linkSty = { color: 'var(--accent)', fontWeight: 600, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 };

export default function OfflineBookingSheet({ booking, onClose }) {
  const clients = useSnapshot('clients');
  const phone = phoneForBooking(booking, clients?.items);
  const tel = telHref(phone);
  const map = mapsHref(booking.locationAddress);
  const video = booking.videoUrl && /^https:\/\//i.test(booking.videoUrl) ? safeHref(booking.videoUrl) : null;
  const queued = queuedFor(booking.id, booking.date);
  const completeQueued = booking.queued || queued.some((q) => q.kind === 'complete');
  const noteQueued = queued.find((q) => q.kind === 'note') || null;
  const [note, setNote] = useState(noteQueued?.note || '');
  const [noteOpen, setNoteOpen] = useState(false);
  const [status, setStatus] = useState(null);

  const base = { date: booking.date, startMin: booking.startMin, endMin: booking.endMin, privateNotes: booking.privateNotes || null };

  const complete = () => {
    const ok = enqueueOfflineAction({ kind: 'complete', bookingId: booking.id, occurrenceDate: booking.date, clientName: booking.clientName, base });
    if (!ok) { setStatus({ kind: 'error', text: 'Could not save this on your phone.' }); return; }
    patchSnapshotBooking(booking.id, { completed: true, queued: true });
    haptic('success');
    setStatus({ kind: 'ok', text: QUEUED_MESSAGE });
  };
  const saveNote = () => {
    const text = note.trim();
    if (!text) return;
    const ok = enqueueOfflineAction({ kind: 'note', bookingId: booking.id, occurrenceDate: booking.date, clientName: booking.clientName, note: text, base });
    if (!ok) { setStatus({ kind: 'error', text: 'Could not save this on your phone.' }); return; }
    haptic();
    setNoteOpen(false);
    setStatus({ kind: 'ok', text: QUEUED_MESSAGE });
  };

  const when = booking.date ? parseDateOnly(booking.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : '';

  return (
    <Drawer title={booking.clientName || 'Appointment'} subtitle="Saved on this phone" onClose={onClose}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icons.Clock size={12}/> {OTHER_CHANGES_MESSAGE}
      </div>
      <Row label="Service">{booking.serviceName || 'Session'}</Row>
      <Row label="When">{when}{Number.isFinite(booking.startMin) ? ` · ${minToHM(booking.startMin)} to ${minToHM(booking.endMin)}` : ''}</Row>
      {booking.locationAddress && (
        <Row label="Address">
          {map ? <a href={map} style={linkSty}><Icons.Globe size={13}/> {booking.locationAddress}</a> : booking.locationAddress}
        </Row>
      )}
      {phone && (
        <Row label="Phone">
          {tel ? <a href={tel} style={linkSty}><Icons.Phone size={13}/> {phone}</a> : phone}
        </Row>
      )}
      {video && (
        <Row label="Video">
          <a href={video} target="_blank" rel="noopener noreferrer" style={linkSty}><Icons.Arrow size={13}/> Open video link</a>
        </Row>
      )}
      {booking.notes && <Row label="Notes">{booking.notes}</Row>}
      {booking.privateNotes && <Row label="Private note">{booking.privateNotes}</Row>}
      {noteQueued && <Row label="Queued note">{noteQueued.note}</Row>}

      {status && (
        <div role="status" style={{
          marginTop: 14, padding: '9px 12px', borderRadius: 10, fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
          background: status.kind === 'ok' ? 'color-mix(in srgb, var(--ok) 12%, var(--surface))' : 'rgba(155,44,44,0.10)',
          color: status.kind === 'ok' ? 'var(--ok)' : 'var(--danger)',
        }}>
          {status.kind === 'ok' ? <Icons.Check size={13} sw={2.4}/> : <Icons.X size={13} sw={2.4}/>} {status.text}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
        {booking.completed || completeQueued ? (
          <div style={{ fontSize: 13, color: 'var(--ok)', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
            <Icons.Check size={14} sw={2.4}/> {completeQueued ? 'Marked complete (sends when you have signal)' : 'Completed'}
          </div>
        ) : booking.noShow ? (
          <div style={{ fontSize: 13, color: 'var(--danger)' }}>Marked as a no-show.</div>
        ) : (
          <button type="button" className="btn btn-primary" onClick={complete} style={{ justifyContent: 'center' }}>
            <Icons.Check size={14} sw={2.4}/> Complete
          </button>
        )}
        {noteOpen ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea className="input" value={note} onChange={(e) => setNote(e.target.value.slice(0, 2000))} rows={3}
              placeholder="A quick note only you see" aria-label="Private note" style={{ resize: 'vertical', fontFamily: 'inherit' }}/>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-outline" onClick={() => setNoteOpen(false)} style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={saveNote} disabled={!note.trim()} style={{ flex: 2, justifyContent: 'center' }}>Save note</button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-outline" onClick={() => setNoteOpen(true)} style={{ justifyContent: 'center' }}>
            <Icons.Edit size={13}/> {noteQueued ? 'Edit private note' : 'Add a private note'}
          </button>
        )}
      </div>
    </Drawer>
  );
}
