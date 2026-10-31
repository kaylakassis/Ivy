// Tabs of a program page: Content, Community, Live and Members. Live shows
// for members once the coach has scheduled something; Members shows when
// the community and its directory are on. The coach always sees Live.
import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Community } from './CommunityFeed.jsx';
import { LiveSessions } from './LiveSessions.jsx';
import { MemberDirectory } from './MemberDirectory.jsx';

// The community summary (role, what is switched on). null while loading
// or when the API is older than this screen.
export function useProgramExtras(programId) {
  const [extras, setExtras] = useState(null);
  useEffect(() => { let on = true; api.get(`/programs/${programId}/community`).then((r) => { if (on) setExtras(r); }).catch(() => {}); return () => { on = false; }; }, [programId]);
  return extras;
}

export function memberTabs({ contentLabel, communityEnabled, extras }) {
  const tabs = [['content', contentLabel]];
  if (communityEnabled) tabs.push(['community', 'Community']);
  if (extras?.hasEvents) tabs.push(['live', extras.upcomingEvents ? `Live (${extras.upcomingEvents})` : 'Live']);
  if (communityEnabled && extras?.directoryEnabled) tabs.push(['members', 'Members']);
  return tabs;
}

export function TabBar({ tabs, tab, setTab }) {
  return (
    <div className="scroll-x" role="tablist" style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, alignSelf: 'flex-start', maxWidth: '100%' }}>
      {tabs.map(([t, l]) => (
        <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} style={{ padding: '7px 12px', borderRadius: 8, fontSize: 13, fontWeight: 550, whiteSpace: 'nowrap', background: tab === t ? 'var(--surface-2)' : 'transparent', color: tab === t ? 'var(--fg)' : 'var(--muted)' }}>{l}</button>
      ))}
    </div>
  );
}

// Body of the non-content tabs, shared by the coach and member pages.
export function ProgramTabBody({ tab, programId, role, communityEnabled }) {
  if (tab === 'community') return <Community programId={programId} enabled={communityEnabled}/>;
  if (tab === 'live') return <LiveSessions programId={programId} role={role}/>;
  if (tab === 'members' && role !== 'owner') return <MemberDirectory programId={programId}/>;
  return null;
}
