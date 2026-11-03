// Phone contacts → clients. Two ways in:
//   • a contacts file (.vcf) read right here in the browser (src/lib/vcard.js)
//   • "Pick from my contacts" via the browser Contact Picker API, where the
//     browser has it (Android Chrome today; hidden everywhere else)
// The owner ticks who is a client; only those people are sent to
// POST /api/clients/import, quietly unless they opt in to automations.
import React, { useMemo, useRef, useState } from 'react';
import { Icons } from '../../../components/Icons.jsx';
import { parseVCards, VCARD_MAX_BYTES } from '../../../lib/vcard.js';
import { Note, QuietNote, PeopleChecklist, AutomationsOptIn, plural } from './parts.jsx';

export function contactPickerSupported() {
  return typeof window !== 'undefined' && typeof navigator !== 'undefined'
    && 'contacts' in navigator && 'ContactsManager' in window;
}

function fromPicker(list) {
  return (list || []).map((c) => ({
    name: String((c.name && c.name[0]) || '').trim().slice(0, 120),
    email: String((c.email && c.email[0]) || '').trim().toLowerCase().slice(0, 254),
    phone: String((c.tel && c.tel[0]) || '').trim().slice(0, 40),
  })).filter((c) => c.name);
}

export default function ContactsImport({ initialContacts, onSubmit, busy, error }) {
  const [contacts, setContacts] = useState(initialContacts || null);
  const [fromPickerApi, setFromPickerApi] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [skippedNoName, setSkippedNoName] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [runAutomations, setRunAutomations] = useState(false);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);
  const picker = contactPickerSupported();

  const onFile = async (file) => {
    if (!file) return;
    setErr(null);
    if (file.size > VCARD_MAX_BYTES) { setErr('That contacts file is over 5 MB. Try exporting a smaller list.'); return; }
    try {
      const r = parseVCards(await file.text());
      if (r.error) { setErr(r.error); return; }
      if (!r.contacts.length) { setErr("We couldn't find any contacts in that file. It should end in .vcf."); return; }
      setContacts(r.contacts);
      setSkippedNoName(r.skipped);
      setTruncated(r.truncated);
      setFromPickerApi(false);
      setSelected(new Set());
    } catch { setErr('Could not read that file.'); }
  };

  const pick = async () => {
    setErr(null);
    try {
      const list = await navigator.contacts.select(['name', 'email', 'tel'], { multiple: true });
      const got = fromPicker(list);
      if (!got.length) return;
      setContacts(got);
      setFromPickerApi(true);
      // Picked on purpose, so everyone picked starts ticked.
      setSelected(new Set(got.map((_, i) => i)));
    } catch (e) {
      if (e?.name !== 'AbortError') setErr('Your phone did not share the contacts. You can upload a contacts file instead.');
    }
  };

  const items = useMemo(() => (contacts || []).map((c, i) => ({
    id: i,
    primary: c.name,
    secondary: [c.email, c.phone].filter(Boolean).join('  ·  ') || 'No email or phone',
  })), [contacts]);

  const submit = () => {
    const rows = (contacts || [])
      .filter((_, i) => selected.has(i))
      .map((c) => ({
        name: c.name,
        ...(c.email ? { email: c.email } : {}),
        ...(c.phone ? { phone: c.phone } : {}),
        stage: 'active',
        source: 'Phone contacts',
      }));
    onSubmit(rows, { quiet: !runAutomations });
  };

  if (!contacts) {
    return (
      <>
        <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Bring in people from your phone, then tick who is a client. Your other contacts stay on your phone.
        </p>
        {picker && (
          <button type="button" onClick={pick} className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', padding: '13px 18px', marginBottom: 10 }}>
            <Icons.Phone size={15}/> Pick from my contacts
          </button>
        )}
        <input ref={fileRef} type="file" accept=".vcf,.vcard,text/vcard,text/x-vcard" hidden
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; onFile(f); }}/>
        <button type="button" onClick={() => fileRef.current?.click()}
          className={picker ? 'btn btn-outline' : 'btn btn-primary'}
          style={{ width: '100%', justifyContent: 'center', padding: '13px 18px' }}>
          <Icons.Doc size={15}/> Upload a contacts file (.vcf)
        </button>
        <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.6 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Getting the file</div>
          <div><strong>iPhone:</strong> open Contacts, touch and hold a list, tap Export, then save the file.</div>
          <div><strong>iCloud.com:</strong> open Contacts, select the people, then export them as a vCard.</div>
        </div>
        {err && <Note tone="err" style={{ marginTop: 12 }}>{err}</Note>}
      </>
    );
  }

  return (
    <>
      <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        {fromPickerApi
          ? <>You picked <strong>{plural(contacts.length, 'person', 'people')}</strong>. Untick anyone who is not a client.</>
          : <>Found <strong>{plural(contacts.length, 'contact')}</strong>. Tick the ones who are clients.</>}
      </p>
      <PeopleChecklist items={items} selected={selected} onChange={setSelected}/>
      {(skippedNoName > 0 || truncated) && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          {skippedNoName > 0 && <>{plural(skippedNoName, 'contact')} with no name left out. </>}
          {truncated && <>Only the first 5,000 contacts are listed.</>}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '14px 0' }}>
        <AutomationsOptIn checked={runAutomations} onChange={setRunAutomations}/>
        {!runAutomations && <QuietNote/>}
      </div>
      {(err || error) && <Note tone="err" style={{ marginBottom: 12 }}>{err || error}</Note>}
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" className="btn btn-outline" onClick={() => { setContacts(null); setSelected(new Set()); }}
          style={{ flex: 1, justifyContent: 'center' }} disabled={busy}>Start over</button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || selected.size === 0}
          style={{ flex: 2, justifyContent: 'center', opacity: busy || selected.size === 0 ? 0.6 : 1 }}>
          {busy ? 'Adding…' : selected.size === 0 ? 'Tick who is a client' : `Add ${plural(selected.size, 'client')}`}
        </button>
      </div>
    </>
  );
}
