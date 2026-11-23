// Full Clients view: header + analytics + tabs + search + table + detail drawer + add modal.
import React, { useState, useMemo, useRef, useEffect, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { SkelRowList } from '../../components/Skeleton.jsx';
import { useClients, usePickerClients } from './state.js';
import ClientDrawer from './ClientDrawer.jsx';
import AddClientModal from './AddClientModal.jsx';
import CustomFieldsSettings from './CustomFieldsSettings.jsx';
import ImportClientsModal from './ImportClientsModal.jsx';
import { isNative } from '../../lib/platform.js';
import { useOffline, useSnapshot } from '../../lib/useOffline.js';
import OfflineClients from '../../components/offline/OfflineClients.jsx';
import AnnounceMoveSheet from './AnnounceMoveSheet.jsx';
import FolderDrawer from './FolderDrawer.jsx';
import { DuplicatesReview, MergeWithPicker } from './DuplicateClients.jsx';
import Loader from '../../components/motion/Loader.jsx';
import { stagger, useFreshKeys, GrowIn } from '../../components/motion/stagger.jsx';
import { useFolders } from './folders.js';
import { useViewport } from '../../lib/viewport.js';
import { api } from '../../lib/api.js';
import { usePullRefresh } from '../../lib/pullRefresh.js';

const DAY = 86400e3;

function timeAgo(iso) {
  if (!iso) return null;
  const d = (Date.now() - new Date(iso).getTime()) / DAY;
  if (d < 1) return 'Today';
  if (d < 2) return 'Yesterday';
  if (d < 30) return `${Math.round(d)}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

// "Tue, Nov 24 at 3:00 PM" (or Today / Tomorrow) for a booking's date and
// start minute. Built from the parts so the day never shifts with time zones.
export function whenText(dateStr, startMin, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return '';
  const mins = Number.isFinite(Number(startMin)) ? Number(startMin) : 0;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Math.floor(mins / 60), mins % 60);
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(d) - day0(now)) / DAY);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow'
    : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return `${day} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

// One line per client that answers "does this person need me?". Why they
// need the owner (from the server, the same rules as Home), or when they
// are next in, or when they were last seen.
export function ClientStatusLine({ client }) {
  const a = client.attention;
  const base = { fontSize: 12.5, lineHeight: 1.35, minWidth: 0 };
  if (a) {
    const color = a.tone === 'danger' ? 'var(--danger)' : a.tone === 'warn' ? 'var(--warn)' : 'var(--fg-2)';
    return (
      <div data-client-status={a.key} style={{ ...base, display: 'flex', alignItems: 'baseline', gap: 6, color: 'var(--fg)' }}>
        <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 99, background: color, flexShrink: 0, transform: 'translateY(-1px)' }}/>
        <span style={{ minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{a.label}</span>
          {a.more > 0 && <span style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}> · plus {a.more} more</span>}
        </span>
      </div>
    );
  }
  if (client.nextBooking) {
    return <div data-client-status="next" style={{ ...base, color: 'var(--fg-2)' }}>Next: {whenText(client.nextBooking.date, client.nextBooking.startMin)}</div>;
  }
  const seen = timeAgo(client.lastSeenAt);
  return <div data-client-status="seen" style={{ ...base, color: 'var(--muted)' }}>{seen ? `Last seen ${seen === 'Today' || seen === 'Yesterday' ? seen.toLowerCase() : seen}` : 'No visits yet'}</div>;
}

// The Clients tab holds three things about the owner's people: the list,
// their rewards (the loyalty program, which used to be under Marketing), and
// the reminders Ivy sends them (birthday, a check-in when they go quiet, a
// book-again link after a visit). ?view=rewards / ?view=reminders opens one.
const Rewards = lazy(() => import('../rewards/Rewards.jsx'));
const Reminders = lazy(() => import('../workflows/ClientAutomations.jsx'));
export const CLIENT_VIEWS = [
  { id: 'list', label: 'Clients' },
  { id: 'rewards', label: 'Rewards' },
  { id: 'reminders', label: 'Reminders' },
];
export function clientViewFor(search) {
  const v = new URLSearchParams(search || '').get('view');
  return v === 'rewards' || v === 'reminders' ? v : 'list';
}

function ViewTabs({ view, onPick }) {
  return (
    <div role="tablist" aria-label="Clients sections" className="tab-row" style={{ display: 'inline-flex', alignSelf: 'flex-start' }}>
      {CLIENT_VIEWS.map((t) => {
        const on = view === t.id;
        return (
          <button key={t.id} type="button" role="tab" aria-selected={on} data-client-view={t.id} onClick={() => onPick(t.id)}
            className="seg-btn" style={{
              padding: '7px 14px', borderRadius: 8, border: 0, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              background: on ? 'var(--surface)' : 'transparent',
              color: on ? 'var(--fg)' : 'var(--muted)',
              boxShadow: on ? 'var(--shadow-sm)' : 'none',
              whiteSpace: 'nowrap',
            }}>{t.label}</button>
        );
      })}
    </div>
  );
}

export default function Clients() {
  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const [leadWindow, setLeadWindow] = useState(30);
  // Customizable window for conversion + churn rate calculations. Default
  // 30 days; owners can dial up to 365 to look at trailing trends.
  const [analyticsWindow, setAnalyticsWindow] = useState(30);
  // The list is paged on the server (50 at a time, "Show more" for the
  // next page) for the current tab and search; counts and the analytics
  // cards are the server's numbers over the whole book.
  const { clients, summary, total, loading, listLoading, error, create, update, remove, refresh,
          hasMore, loadMore, loadingMore } = useClients({ tab, query, analyticsWindow, leadWindow });
  usePullRefresh(refresh);
  // iPhone app with no signal: the list and a client's essentials from the
  // copy saved on the phone.
  const offline = useOffline();
  const offlineSnapshot = useSnapshot('clients');
  const offlineView = !!error && !clients.length && isNative() && (offline || error.offline);
  // Signal is back: load the live list.
  useEffect(() => { if (offlineView && !offline) refresh(); }, [offlineView, offline, refresh]);
  const [openId, setOpenId] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // "Let your clients know" (the "I've moved to Ivy" email), opened by
  // /clients?announce=1 - Ivy's import "Done" message links there.
  const [announceOpen, setAnnounceOpen] = useState(false);
  // Custom client fields (CustomFieldsSettings), also /clients?fields=1.
  const [fieldsOpen, setFieldsOpen] = useState(false);
  // Possible duplicates: the count for the entry (shown only when > 0), the
  // review list (also /clients?duplicates=1) and "Merge with..." on a client.
  const [dupCount, setDupCount] = useState(0);
  const [dupOpen, setDupOpen] = useState(false);
  const [mergeWith, setMergeWith] = useState(null);
  const [dupTick, setDupTick] = useState(0);
  // One line after an add: was the portal invite emailed or not (and why).
  const [addNotice, setAddNotice] = useState(null);
  useEffect(() => {
    if (!addNotice) return undefined;
    const t = setTimeout(() => setAddNotice(null), 8000);
    return () => clearTimeout(t);
  }, [addNotice]);
  const { isMobile, isTablet } = useViewport();
  // The client table needs about 900px. On an iPad held upright it squeezed
  // names down to two letters, so that width gets the card list too.
  const cardList = isMobile || isTablet;

  // Folders (stored as projects). Any client can become a folder: their
  // bookings, invoices, quotes and documents in one place. The list
  // stays a contact list; the folder is a chip on the row.
  const location = useLocation();
  const navigate = useNavigate();
  const folderState = useFolders();
  const [openFolderId, setOpenFolderId] = useState(null);
  const [makingFolderFor, setMakingFolderFor] = useState(null);
  const foldersByClient = useMemo(() => {
    const m = {};
    for (const f of folderState.folders) {
      if (!f.clientId) continue;
      (m[f.clientId] ||= []).push(f);
    }
    return m;
  }, [folderState.folders]);
  const looseFolders = useMemo(() => folderState.folders.filter((f) => !f.clientId), [folderState.folders]);
  const [looseOpen, setLooseOpen] = useState(false);

  // One tap turns a client into a folder named after them and opens it.
  const makeFolder = async (client) => {
    if (makingFolderFor) return;
    setMakingFolderFor(client.id);
    try {
      const created = await folderState.create({ name: client.name, clientId: client.id, status: 'active' });
      if (created) { setOpenId(null); setOpenFolderId(created.id); }
    } catch (e) {
      console.warn('[Clients] folder create failed:', e.message);
    } finally {
      setMakingFolderFor(null);
    }
  };
  const openClientFolder = (client) => {
    const list = foldersByClient[client.id] || [];
    if (list.length === 0) return makeFolder(client);
    setOpenId(null);
    setOpenFolderId(list[0].id);
  };

  // Bulk metrics keyed by clientId: sessions left, due date, monthly $,
  // 30-day revenue. One round-trip on mount + on `clients` length change
  // (so newly-added clients pick up zero-state metrics immediately).
  const [metricsById, setMetricsById] = useState({});
  useEffect(() => {
    let live = true;
    api.get('/clients/metrics?all=1')
      .then((r) => { if (live) setMetricsById(r.metrics || {}); })
      .catch((e) => console.warn('[Clients] metrics fetch failed:', e.message));
    return () => { live = false; };
  }, [summary?.counts?.all]);

  useEffect(() => {
    let live = true;
    api.get('/clients/duplicates?count=1')
      .then((r) => { if (live) setDupCount(Number(r.total) || 0); })
      .catch(() => { /* helpers and older servers: no entry */ });
    return () => { live = false; };
  }, [summary?.counts?.all, dupTick]);

  // After a merge: reload the list, and keep the kept client open when the
  // merge started from one of them.
  const afterMerge = async (result, removedId) => {
    setMergeWith(null);
    if (openId === removedId) setOpenId(result?.keptClientId || null);
    try { await refresh?.(); } catch { /* the list reloads on next visit */ }
    setDupTick((t) => t + 1);
  };

  // Deep-link support so other pages can route here with a modal opened.
  // Used by Dashboard hero "Add client" and per-client quick actions.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('folder')) {
      setOpenId(null);
      setOpenFolderId(params.get('folder'));
      params.delete('folder');
      params.delete('view');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    } else if (params.get('view') && clientViewFor(location.search) === 'list') {
      // (An old ?view=folders link. Rewards and Reminders keep theirs.)
      params.delete('view');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }
    if (params.get('add') === '1') {
      setAddOpen(true);
      params.delete('add');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }
    // ?import=1 opens the import hub (dashboard "Switching from another
    // app?" card); ?announce=1 opens the "Let your clients know" sheet.
    if (params.get('import') === '1') {
      setImportOpen(true);
      params.delete('import');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }
    if (params.get('fields') === '1') {
      setFieldsOpen(true);
      params.delete('fields');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }
    if (params.get('duplicates') === '1') {
      setDupOpen(true);
      params.delete('duplicates');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }
    if (params.get('announce') === '1') {
      setAnnounceOpen(true);
      params.delete('announce');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }
    // ?filter=missing-email opens the "Missing email" list (linked from
    // Ivy after an import and from the dashboard reminder).
    if (params.get('filter') === 'missing-email') {
      setTab('noemail');
      params.delete('filter');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }
    // ?filter=leads opens the Leads tab (accountability partner, dashboard).
    if (params.get('filter') === 'leads') {
      setTab('leads');
      params.delete('filter');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }
    if (params.get('id')) {
      setOpenId(params.get('id'));
      params.delete('id');
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // Whole-book numbers from the server (GET /api/clients?summary=1).
  const counts = summary?.counts || { all: 0, active: 0, leads: 0, paused: 0, noemail: 0 };
  const analytics = summary?.analytics || {
    recentActives: 0, recentLeads: 0, conversionRate: 0, churnCount: 0, churnRate: 0, leadsInWindow: 0,
  };

  // The server already filtered this page by tab and search; the same
  // test runs here so a row edited away from the tab (marked paused on the
  // Active tab, say) leaves the list straight away.
  const ql = query.trim().toLowerCase();
  const rows = clients.filter((c) => {
    if (tab === 'active' && c.stage !== 'active') return false;
    if (tab === 'leads' && c.stage !== 'lead') return false;
    if (tab === 'paused' && c.stage !== 'paused') return false;
    if (tab === 'noemail' && (c.email || '').trim()) return false;
    if (tab === 'attention' && !c.attention) return false;
    if (!ql) return true;
    return (c.name || '').toLowerCase().includes(ql)
      || (c.email || '').toLowerCase().includes(ql)
      || (c.tags || []).some((t) => String(t).toLowerCase().includes(ql));
  });
  const remaining = total == null ? null : Math.max(0, total - clients.length);

  const setStage = (id, stage) => update(id, { stage });

  const onAdd = async (input) => {
    const made = await create(input);
    setAddOpen(false);
    setAddNotice(inviteNotice(made));
  };

  // ---- pieces of the screen, ordered below ---------------------------------
  // Search and the filters come first and the clients right after them. On
  // a phone the summary numbers sit under the list (they used to push the
  // first client almost off the first screen).
  const TABS = [
    ['all', 'All'],
    // The server sends this count to the owner only; a helper has no such filter.
    ...(!summary?.counts || 'attention' in summary.counts ? [['attention', 'Needs attention']] : []),
    ['active', 'Active'], ['leads', 'Leads'], ['paused', 'Paused'],
    ...(counts.noemail || tab === 'noemail' ? [['noemail', 'Missing email']] : []),
  ];
  const searchBox = (
    <div className="focus-within-ring" style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: cardList ? '9px 12px' : '6px 12px',
      borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)',
      width: cardList ? '100%' : undefined, boxSizing: 'border-box',
    }}>
      <Icons.Search size={cardList ? 15 : 13} sw={1.8} stroke="var(--muted)"/>
      <input value={query} onChange={(e) => setQuery(e.target.value)}
        aria-label="Search clients" enterKeyHint="search"
        placeholder="Search by name, email, or tag"
        style={{ border: 0, outline: 0, background: 'transparent', fontSize: cardList ? 16 : 13, width: cardList ? '100%' : 200, minWidth: 0, flex: cardList ? 1 : undefined, color: 'var(--fg)' }}/>
    </div>
  );
  const tabRow = (
    <div className="tab-row" role="tablist" aria-label="Filter clients">
      {TABS.map(([id, label]) => {
        const n = counts[id] || 0;
        const flag = id === 'attention' && n > 0;
        return (
          <button key={id} role="tab" aria-selected={tab === id} data-client-tab={id} onClick={() => setTab(id)} style={{
            padding: '6px 14px', borderRadius: 8, border: 0, fontSize: 12.5, fontWeight: 550, cursor: 'pointer',
            background: tab === id ? 'var(--surface)' : 'transparent',
            color: tab === id ? 'var(--fg)' : 'var(--muted)',
            boxShadow: tab === id ? 'var(--shadow-sm)' : 'none',
            display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
          }}>
            {label}
            <span style={{
              fontSize: 10.5, padding: '1px 6px', borderRadius: 99,
              background: flag ? 'var(--warn)' : (tab === id ? 'var(--surface-2)' : 'var(--surface)'),
              color: flag ? '#1b1300' : 'var(--muted)', fontWeight: 700,
            }}>{n}</span>
          </button>
        );
      })}
    </div>
  );
  const filterBlock = cardList ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {searchBox}
      {tabRow}
    </div>
  ) : (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {tabRow}
      <div style={{ flex: 1 }}/>
      {searchBox}
    </div>
  );
  // One slim line, not a card: it matters now and then, not every visit.
  const dupBlock = dupCount > 0 && (
    <button type="button" onClick={() => setDupOpen(true)} data-dup-strip style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
      padding: '8px 12px', borderRadius: 10, cursor: 'pointer', fontSize: 13,
      background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--fg-2)',
    }}>
      <Icons.Users size={14} sw={1.8} stroke="var(--accent)"/>
      <span style={{ flex: 1, minWidth: 0 }}>{dupCount} possible duplicate{dupCount === 1 ? '' : 's'}</span>
      <span style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 12.5 }}>Review</span>
      <Icons.Arrow size={13} stroke="var(--muted)"/>
    </button>
  );
  const statsBlock = (
  <div className="grid-auto stat-grid">
    <AnalyticCard label="Total clients" value={counts.active + counts.paused}
      sub={`${counts.active} active · ${counts.paused} paused`} icon={<Icons.Users size={16} sw={1.8}/>}/>
    <AnalyticCard
      label={<>Leads in last <EditableNumber value={leadWindow} onChange={setLeadWindow} min={1} max={365}/> days</>}
      value={analytics.leadsInWindow}
      sub={`${counts.leads} total leads`}
      icon={<Icons.Plus size={16} sw={2}/>}
      tone="accent"/>
    <AnalyticCard
      label={<>Conversion rate · last <EditableNumber value={analyticsWindow} onChange={setAnalyticsWindow} min={1} max={365}/> days</>}
      value={analytics.conversionRate + '%'}
      sub={`${analytics.recentActives}/${analytics.recentActives + analytics.recentLeads} in window`}
      icon={<Icons.Trending size={16} sw={1.8}/>}
      tone={analytics.conversionRate >= 30 ? 'ok' : analytics.conversionRate >= 15 ? 'neutral' : 'warn'}/>
    <AnalyticCard
      label={<>Churn rate · last <EditableNumber value={analyticsWindow} onChange={setAnalyticsWindow} min={1} max={365}/> days</>}
      value={analytics.churnRate + '%'}
      sub={`${analytics.churnCount} paused in window`}
      icon={<Icons.Clock size={16} sw={1.8}/>}
      tone={analytics.churnRate > 20 ? 'bad' : analytics.churnRate > 10 ? 'warn' : 'ok'}/>
  </div>
  );

  // A client opened by link (?id=) may not be on a loaded page yet.
  const [linkedClient, setLinkedClient] = useState(null);
  const listedClient = clients.find((c) => c.id === openId) || null;
  useEffect(() => {
    // Offline view: the saved copy has the client; no fetch (it would fail
    // and close the sheet).
    if (!openId || listedClient || linkedClient?.id === openId || offlineView) return undefined;
    let live = true;
    api.get('/clients/' + openId)
      .then((r) => { if (live && r.client) setLinkedClient(r.client); })
      .catch(() => { if (live) setOpenId(null); });
    return () => { live = false; };
  }, [openId, listedClient, linkedClient, offlineView]);
  const openClient = listedClient || (linkedClient?.id === openId ? linkedClient : null);
  // Pickers that choose any client (merge, folder owner) get the full list
  // while they are open.
  const pickerClients = usePickerClients(!!mergeWith || !!openFolderId);
  const openFolder = folderState.folders.find((f) => f.id === openFolderId) || null;
  // Rows that appeared after the first load (a client just created) grow in
  // live; the ones that were there on load get the list stagger instead.
  const freshIds = useFreshKeys(clients.map((c) => c.id), { ready: !loading });

  const view = clientViewFor(location.search);
  const pickView = (id) => {
    const p = new URLSearchParams(location.search);
    if (id === 'list') p.delete('view'); else p.set('view', id);
    navigate({ pathname: location.pathname, search: p.toString() }, { replace: true });
  };

  if (offlineView) {
    return <OfflineClients snapshot={offlineSnapshot} openId={openId} onOpen={setOpenId} onClose={() => setOpenId(null)}/>;
  }

  if (view !== 'list') {
    return (
      <div data-client-section={view}>
        <div className="page-pad" style={{ paddingBottom: 0, display: 'flex', flexDirection: 'column' }}>
          <ViewTabs view={view} onPick={pickView}/>
        </div>
        <div key={view} className="panel-enter">
          <Suspense fallback={<div className="page-pad"><Loader/></div>}>
            {view === 'rewards' ? <Rewards/> : <div className="page-pad"><Reminders/></div>}
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ViewTabs view={view} onPick={pickView}/>
      {/* The list is the screen: one primary action here, the occasional
          ones (import, custom fields) behind the menu, and no explanation
          text pushing the first client down the page. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {!cardList && <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>Clients</h2>}
        </div>
        <div style={{ display: 'flex', gap: 8, position: 'relative' }}>
          <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
            <Icons.Plus size={13} sw={2}/> Add client
          </button>
          <button className="btn btn-outline" onClick={() => setMoreOpen((v) => !v)}
            aria-label="More client tools" aria-haspopup="menu" aria-expanded={moreOpen} style={{ padding: '8px 10px' }}>
            <Icons.More size={16}/>
          </button>
          {moreOpen && (
            <>
              <div onClick={() => setMoreOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} aria-hidden="true"/>
              <div role="menu" className="card" style={{
                position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 41, padding: 4, minWidth: 210,
                display: 'flex', flexDirection: 'column', gap: 2, boxShadow: 'var(--shadow)',
              }}>
                <button role="menuitem" className="btn btn-ghost" style={{ justifyContent: 'flex-start', gap: 8 }}
                  onClick={() => { setMoreOpen(false); setImportOpen(true); }}>
                  <Icons.Doc size={14}/> Import clients
                </button>
                <button role="menuitem" className="btn btn-ghost" style={{ justifyContent: 'flex-start', gap: 8 }}
                  onClick={() => { setMoreOpen(false); setFieldsOpen(true); }}>
                  <Icons.Settings size={14}/> Custom fields
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {openFolder && (
        <FolderDrawer
          folder={openFolder}
          clients={pickerClients || clients}
          onClose={() => setOpenFolderId(null)}
          onUpdate={(patch) => folderState.update(openFolder.id, patch)}
          onDelete={async () => { await folderState.remove(openFolder.id); setOpenFolderId(null); }}
        />
      )}

      {addNotice && (
        <div role="status" className="card" style={{
          padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 13, color: 'var(--fg-2)',
        }}>
          <span style={{ color: addNotice.ok ? 'var(--ok)' : 'var(--muted)', display: 'inline-flex' }}>
            {addNotice.ok ? <Icons.Check size={14} sw={2.4}/> : <Icons.Mail size={14}/>}
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>{addNotice.text}</span>
          <button type="button" className="btn btn-ghost" onClick={() => setAddNotice(null)}
            aria-label="Dismiss" style={{ padding: 4 }}>
            <Icons.X size={13}/>
          </button>
        </div>
      )}

      {!cardList && statsBlock}
      {filterBlock}
      {dupBlock}

      {/* Table - desktop/tablet keeps the 6-column grid; mobile collapses
          to a stacked card list since six fixed-width columns can't fit
          a phone viewport without horizontal scroll. */}
      <div className="card stagger" style={{ overflow: 'hidden' }}>
        {!cardList && (
          <div style={{
            display: 'grid', gridTemplateColumns: '1.5fr 96px 0.9fr 1.35fr 118px 100px 40px',
            padding: '12px 20px', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase',
            fontWeight: 600, color: 'var(--muted)', borderBottom: '1px solid var(--border)',
            background: 'var(--surface-2)', gap: 8,
          }}>
            <div>Client</div><div>Stage</div><div>Health</div><div>What&apos;s next</div>
            <div>Folder</div>
            <div style={{ textAlign: 'right' }}>Lifetime</div><div/>
          </div>
        )}
        {loading || (listLoading && rows.length === 0) ? (
          <div style={{ padding: 16 }}><SkelRowList rows={8} withAvatar/><Loader/></div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 48 }}>
            <EmptyNote
              icon="Users"
              title={query.trim() ? `No clients match "${query.trim()}"` : tab === 'all' ? 'No clients yet' : tab === 'noemail' ? 'Every client has an email' : tab === 'attention' ? 'Nobody needs you right now' : `No ${tab} match`}
              hint={query.trim() ? 'Check the spelling, or clear the search to see everyone.'
                : tab === 'all'
                ? 'Add your first client or lead to start your book of business.'
                : tab === 'noemail' ? 'Booking reminders can reach everyone.'
                : tab === 'attention' ? 'A client shows up here when they owe money, message you, run out of sessions, or go quiet.'
                : 'Try a different tab or clear your search.'}
            />
          </div>
        ) : rows.map((c, i) => (
          <GrowIn key={c.id} fresh={freshIds.has(c.id)}>{cardList ? (
            <ClientCardMobile client={c} first={i === 0} index={i}
              metrics={metricsById[c.id]}
              folders={foldersByClient[c.id]} folderBusy={makingFolderFor === c.id}
              onFolder={() => openClientFolder(c)}
              onOpen={() => setOpenId(c.id)}
              onStage={(st) => setStage(c.id, st)}
              onMerge={() => setMergeWith(c)}
              onDelete={() => remove(c.id)}/>
          ) : (
            <ClientRow client={c} first={i === 0} index={i}
              metrics={metricsById[c.id]}
              folders={foldersByClient[c.id]} folderBusy={makingFolderFor === c.id}
              onFolder={() => openClientFolder(c)}
              onOpen={() => setOpenId(c.id)}
              onStage={(st) => setStage(c.id, st)}
              onMerge={() => setMergeWith(c)}
              onDelete={() => remove(c.id)}/>
          )}</GrowIn>
        ))}

        {/* Next page from the server for this tab + search. */}
        {hasMore && (
          <div style={{ padding: 16, textAlign: 'center', borderTop: '1px solid var(--border)' }}>
            <button
              type="button"
              className="btn btn-outline"
              data-testid="clients-show-more"
              disabled={loadingMore}
              onClick={loadMore}
              style={{ padding: '8px 18px', fontSize: 13 }}>
              {loadingMore ? 'Loading…' : remaining ? `Show more (${remaining} more)` : 'Show more'}
            </button>
          </div>
        )}
      </div>

      {/* Phones and tablets: the summary numbers come after the clients. */}
      {cardList && statsBlock}

      {/* Folders not tied to any client (made from Ivy or before a client
          existed). Tucked away; most owners never have one. */}
      {looseFolders.length > 0 && (
        <div className="card" style={{ padding: '10px 16px' }}>
          <button onClick={() => setLooseOpen((o) => !o)} style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 0, background: 'transparent',
            color: 'var(--muted)', fontSize: 12.5, cursor: 'pointer', padding: 0, textAlign: 'left',
          }}>
            <Icons.Folder size={13} sw={1.8}/>
            {looseFolders.length} folder{looseFolders.length === 1 ? '' : 's'} not tied to a client
            <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontWeight: 600 }}>{looseOpen ? 'Hide' : 'Show'}</span>
          </button>
          {looseOpen && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {looseFolders.map((f) => (
                <button key={f.id} onClick={() => setOpenFolderId(f.id)} className="btn btn-outline" style={{ fontSize: 12.5, padding: '5px 11px' }}>
                  <Icons.Folder size={12} sw={1.8}/> {f.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {openClient && (
        <ClientDrawer
          client={openClient}
          analyticsWindowDays={analyticsWindow}
          onClose={() => setOpenId(null)}
          onUpdate={async (patch) => {
            const saved = await update(openClient.id, patch);
            if (saved && linkedClient?.id === saved.id) setLinkedClient(saved);
            return saved;
          }}
          onDelete={async () => { await remove(openClient.id); setOpenId(null); }}
          onOpenFolder={(id) => { setOpenId(null); folderState.refresh(); setOpenFolderId(id); }}
          onMakeFolder={() => makeFolder(openClient)}
          onMergeWith={() => setMergeWith(openClient)}
          clientFolders={foldersByClient[openClient.id] || []}
        />
      )}
      {dupOpen && (
        <DuplicatesReview
          onClose={() => setDupOpen(false)}
          onCountChange={setDupCount}
          onMerged={(r) => afterMerge(r, null)}
        />
      )}
      {mergeWith && (
        <MergeWithPicker
          client={mergeWith}
          clients={pickerClients || clients}
          onClose={() => setMergeWith(null)}
          onMerged={afterMerge}
          onOpenClient={(id) => setOpenId(id)}
        />
      )}
      {addOpen && <AddClientModal onClose={() => setAddOpen(false)} onAdd={onAdd}/>}
      {importOpen && (
        <ImportClientsModal
          onClose={() => setImportOpen(false)}
          onComplete={() => { refresh?.(); setDupTick((t) => t + 1); }}
        />
      )}
      {announceOpen && <AnnounceMoveSheet onClose={() => setAnnounceOpen(false)}/>}
      {fieldsOpen && <CustomFieldsSettings onClose={() => setFieldsOpen(false)}/>}
    </div>
  );
}

// The line shown after Add client: did the portal invite go out?
// Honest about why not (no email, left unticked, client opted out).
function inviteNotice(client) {
  const name = client?.name || 'Your client';
  const inv = client?.invite;
  if (!inv) return { ok: true, text: `${name} added.` };
  if (inv.sent) return { ok: true, text: `${name} added. Portal invite sent to ${client.email}.` };
  const why = {
    'no-email': 'No invite sent because there is no email on file.',
    off: 'Added quietly, no invite sent. You can invite them from their profile.',
    muted: 'No invite sent: they have turned off emails from your business.',
    'already-invited': 'They were already invited.',
    'workspace-quota-exceeded': "No invite sent: you reached today's email limit. Try again from their profile tomorrow.",
  }[inv.reason] || 'The invite did not go out. You can resend it from their profile.';
  return { ok: inv.reason === 'off' || inv.reason === 'no-email', text: `${name} added. ${why}` };
}

function ClientRow({ client, first, index, metrics, folders, folderBusy, onFolder, onOpen, onStage, onMerge, onDelete }) {
  const initials = (client?.name || '').split(' ').map((n) => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1.5fr 96px 0.9fr 1.35fr 118px 100px 40px',
      padding: '14px 20px', alignItems: 'center', gap: 8,
      borderTop: first ? 'none' : '1px solid var(--border)',
      cursor: 'pointer', transition: 'background .1s', ...stagger(index),
    }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      onClick={onOpen}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 99, flexShrink: 0,
          background: 'var(--accent-soft)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 600,
        }}>{initials || '?'}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {client.name}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {client.email || '-'}
          </div>
        </div>
      </div>
      <div><StageChip stage={client.stage}/></div>
      <ClientMetricsChips metrics={metrics}/>
      <ClientStatusLine client={client}/>
      <div onClick={(e) => e.stopPropagation()}>
        <FolderChip folders={folders} busy={folderBusy} onClick={onFolder}/>
      </div>
      <div style={{ textAlign: 'right', fontSize: 14, fontWeight: 600 }} className="mono-num">
        {client.lifetimeValue > 0 ? '$' + client.lifetimeValue.toLocaleString() : '-'}
      </div>
      <div style={{ textAlign: 'right', color: 'var(--muted)' }} onClick={(e) => e.stopPropagation()}>
        <RowMenu client={client} onStage={onStage} onOpen={onOpen} onMerge={onMerge} onDelete={onDelete}/>
      </div>
    </div>
  );
}

// Compact chip strip showing the most actionable health signals for a
// client at a glance. Each chip only renders when the underlying value
// is non-zero / present, so silent clients show a clean row.
//
// Order is deliberate:
//   1. sessions left   - most actionable; owners decide who to upsell
//   2. monthly payment - recurring revenue context
//   3. due date        - what needs collecting / billing next
//   4. 30d revenue     - momentum
// `quiet`: render nothing when there is nothing to show (the phone card),
// instead of the dash the desktop table column needs.
function ClientMetricsChips({ metrics, quiet = false }) {
  if (!metrics) return quiet ? null : <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>-</div>;
  const chips = [];
  if (metrics.sessionsLeft > 0) {
    chips.push({
      key: 'sessions',
      label: `${metrics.sessionsLeft} session${metrics.sessionsLeft === 1 ? '' : 's'} left`,
      tone: metrics.sessionsLeft <= 1 ? 'warn' : 'default',
      title: metrics.sessionsLeft <= 1 ? 'Running low - good time to offer a renewal' : null,
    });
  } else if (metrics.packagesExhausted > 0) {
    chips.push({ key: 'sessions', label: 'Out of sessions', tone: 'warn',
      title: 'Active package is exhausted - offer a renewal' });
  }
  if (metrics.monthlyPaymentCents > 0) {
    chips.push({
      key: 'monthly',
      label: '$' + (metrics.monthlyPaymentCents / 100).toFixed(0) + '/mo',
      tone: 'default',
    });
  }
  if (metrics.dueDate) {
    const d = new Date(metrics.dueDate);
    // Skip the chip rather than render "Invalid Date" if the API returned
    // a malformed timestamp.
    if (!Number.isFinite(d.getTime())) {
      // fall through - no due chip
    } else {
    const days = Math.ceil((d - Date.now()) / 86400e3);
    const fmt = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    let tone = 'default';
    if (days < 0) tone = 'danger';
    else if (days <= 3) tone = 'warn';
    chips.push({
      key: 'due',
      label: `Due ${fmt}`,
      tone,
      title: metrics.dueDateKind === 'invoice'
        ? `Unpaid invoice due ${fmt}` : `Next billing on ${fmt}`,
    });
    }
  }
  if (metrics.revenue30dCents > 0) {
    chips.push({
      key: 'rev30',
      label: '$' + (metrics.revenue30dCents / 100).toFixed(0) + ' / 30d',
      tone: 'default',
    });
  }
  if (chips.length === 0) {
    return quiet ? null : <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>-</div>;
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0 }}>
      {chips.map((c) => <MetricChip key={c.key} {...c}/>)}
    </div>
  );
}

function MetricChip({ label, tone, title }) {
  const tones = {
    default: { bg: 'var(--surface-2)', fg: 'var(--fg-2)',   bd: 'var(--border)' },
    warn:    { bg: 'rgba(220,180,50,0.10)', fg: '#a78a1f',   bd: 'rgba(220,180,50,0.45)' },
    danger:  { bg: 'rgba(155,44,44,0.10)',  fg: 'var(--danger)', bd: 'rgba(155,44,44,0.45)' },
  };
  const t = tones[tone] || tones.default;
  return (
    <span title={title || undefined} style={{
      fontSize: 11, fontWeight: 500, padding: '2px 7px', borderRadius: 99,
      background: t.bg, color: t.fg, border: '1px solid ' + t.bd,
      whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

// Mobile variant - same data, stacked vertically. Two visible lines
// (avatar+name+email, stage chip + last seen + lifetime) so the phone
// shows enough to triage clients without horizontal scroll.
function ClientCardMobile({ client, first, index, metrics, folders, folderBusy, onFolder, onOpen, onStage, onMerge, onDelete }) {
  const initials = (client?.name || '').split(' ').map((n) => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
  return (
    <div
      onClick={onOpen}
      style={{
        padding: '14px 16px',
        borderTop: first ? 'none' : '1px solid var(--border)',
        cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 12, ...stagger(index),
      }}
    >
      <div style={{
        width: 40, height: 40, borderRadius: 99, flexShrink: 0,
        background: 'var(--accent-soft)', color: 'var(--accent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 600,
      }}>{initials || '?'}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 14, fontWeight: 600,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{client.name}</span>
          {client.lifetimeValue > 0 && (
            <span className="mono-num" style={{ fontSize: 12.5, color: 'var(--fg-2)', flexShrink: 0 }}>
              ${client.lifetimeValue.toLocaleString()}
            </span>
          )}
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginTop: 4,
          fontSize: 11.5, color: 'var(--muted)',
        }}>
          <StageChip stage={client.stage}/>
        </div>
        <div style={{ marginTop: 5 }}><ClientStatusLine client={client}/></div>
        <div style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
          <FolderChip folders={folders} busy={folderBusy} onClick={onFolder}/>
        </div>
        {metrics && (
          <div style={{ marginTop: 6 }}>
            <ClientMetricsChips metrics={metrics} quiet/>
          </div>
        )}
      </div>
      <div onClick={(e) => e.stopPropagation()} style={{ color: 'var(--muted)' }}>
        <RowMenu client={client} onStage={onStage} onOpen={onOpen} onMerge={onMerge} onDelete={onDelete}/>
      </div>
    </div>
  );
}

// Renders the menu via React portal so it escapes the table card's overflow:hidden.
// Position is computed from the trigger button's bounding rect on each open.
function RowMenu({ client, onStage, onOpen, onMerge, onDelete }) {
  const [open, setOpen]   = useState(false);
  const [pos, setPos]     = useState({ top: 0, left: 0 });
  const [confirmDel, setConfirmDel] = useState(false);
  const [busyDel, setBusyDel] = useState(false);
  const [delErr, setDelErr] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const place = () => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const menuW = 200;
    setPos({
      top:  r.bottom + 4,
      left: Math.max(8, r.right - menuW),
    });
  };

  const toggle = () => {
    if (!open) { place(); setConfirmDel(false); setDelErr(null); }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (btnRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onClick);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onClick);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const stageOpts = [
    { stage: 'active', label: 'Mark active' },
    { stage: 'paused', label: 'Mark paused' },
    { stage: 'lead',   label: 'Mark as lead' },
  ].filter((o) => o.stage !== client.stage);

  const doDelete = async () => {
    setBusyDel(true);
    setDelErr(null);
    try {
      await onDelete();
      setOpen(false);
    } catch (e) {
      setDelErr(e.message || 'Delete failed');
    } finally {
      setBusyDel(false);
    }
  };

  return (
    <>
      <button ref={btnRef} onClick={toggle} className="btn btn-ghost" style={{ padding: 6 }}
        aria-label={`More actions for ${client.name || 'this client'}`} title="More actions">
        <Icons.More size={14}/>
      </button>
      {open && createPortal(
        <div ref={menuRef} style={{
          position: 'fixed', top: pos.top, left: pos.left, zIndex: 200,
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          borderRadius: 10, boxShadow: 'var(--shadow)', minWidth: 200, padding: 4,
        }}>
          <MenuItem onClick={() => { onOpen(); setOpen(false); }} icon={<Icons.Edit size={13}/>}>
            Open details
          </MenuItem>
          {stageOpts.map((o) => (
            <MenuItem key={o.stage} onClick={() => { onStage(o.stage); setOpen(false); }}>
              {o.label}
            </MenuItem>
          ))}
          {onMerge && (
            <MenuItem onClick={() => { onMerge(); setOpen(false); }} icon={<Icons.MoveTo size={13}/>}>
              Merge with…
            </MenuItem>
          )}
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }}/>
          {confirmDel ? (
            <div style={{ padding: '6px 10px' }}>
              <div style={{ fontSize: 11.5, color: 'var(--danger)', marginBottom: 6 }}>
                Delete {client.name}? This can't be undone.
              </div>
              {delErr && (
                <div style={{ fontSize: 11, color: 'var(--danger)', marginBottom: 6, lineHeight: 1.4 }}>
                  {delErr}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost" disabled={busyDel}
                  style={{ flex: 1, padding: '5px 8px', fontSize: 12, justifyContent: 'center' }}
                  onClick={() => setConfirmDel(false)}>
                  Cancel
                </button>
                <button className="btn btn-primary" disabled={busyDel}
                  style={{ flex: 1, padding: '5px 8px', fontSize: 12, justifyContent: 'center', background: 'var(--danger)', color: '#fff', opacity: busyDel ? 0.6 : 1 }}
                  onClick={doDelete}>
                  {busyDel ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          ) : (
            <MenuItem danger onClick={() => setConfirmDel(true)} icon={<Icons.Trash size={13}/>}>
              Delete client
            </MenuItem>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

function MenuItem({ children, onClick, icon, danger }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8,
      width: '100%', padding: '8px 12px', border: 0, background: 'transparent',
      fontSize: 12.5, color: danger ? 'var(--danger)' : 'var(--fg)',
      cursor: 'pointer', textAlign: 'left', borderRadius: 6,
    }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {icon}{children}
    </button>
  );
}

// The folder on a contact. Green chip with a file count when the client
// has one (tap to open); a quiet "Make folder" when they don't (tap to
// create it, named after them, and open it).
function FolderChip({ folders, busy, onClick }) {
  const list = folders || [];
  if (list.length === 0) {
    return (
      <button type="button" onClick={onClick} disabled={busy} title="Turn this client into a folder: all of their files in one place" style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 99,
        fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
        background: 'transparent', color: 'var(--muted)', border: '1px dashed var(--border-strong)',
        opacity: busy ? 0.6 : 1,
      }}>
        <Icons.Plus size={11} sw={2}/> {busy ? 'Making…' : 'Make folder'}
      </button>
    );
  }
  const n = list.reduce((s, f) => { const c = f.counts || {}; return s + (c.bookings || 0) + (c.invoices || 0) + (c.quotes || 0) + (c.documents || 0); }, 0);
  return (
    <button type="button" onClick={onClick} title="Open this client's folder" style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 99,
      fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
      background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid transparent',
    }}>
      <Icons.Folder size={12} sw={1.9}/>
      {n === 0 ? 'Empty folder' : `${n} file${n === 1 ? '' : 's'}`}
      {list.length > 1 && <span style={{ opacity: 0.75 }}>· {list.length} folders</span>}
    </button>
  );
}

export function StageChip({ stage }) {
  const map = {
    active: { fg: 'var(--ok)',     label: 'Active' },
    lead:   { fg: 'var(--accent)', label: 'Lead' },
    paused: { fg: 'var(--muted)',  label: 'Paused' },
  };
  const s = map[stage] || map.active;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 10px', borderRadius: 99,
      fontSize: 11, fontWeight: 600,
      background: 'var(--surface-2)', border: '1px solid var(--border)', color: s.fg,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 99, background: s.fg }}/>
      {s.label}
    </span>
  );
}

function AnalyticCard({ label, value, sub, icon, tone = 'neutral' }) {
  const colors = {
    ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--danger)',
    accent: 'var(--accent)', neutral: 'var(--muted)',
  };
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8, background: 'var(--surface-2)',
          color: colors[tone], flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{icon}</div>
        <div className="metric-label" style={{
          lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{label}</div>
      </div>
      <div className="metric-value" style={{ fontSize: 28 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{sub}</div>
    </div>
  );
}

function EditableNumber({ value, onChange, min = 1, max = 365 }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  React.useEffect(() => setV(value), [value]);
  if (editing) {
    return (
      <input type="number" value={v} autoFocus min={min} max={max}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { const n = Math.max(min, Math.min(max, Number(v) || value)); onChange(n); setEditing(false); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.target.blur();
          if (e.key === 'Escape') { setV(value); setEditing(false); }
        }}
        style={{
          width: 48, padding: '1px 4px', borderRadius: 4, fontSize: 11, fontWeight: 700,
          border: '1px solid var(--accent)', background: 'var(--surface)', color: 'var(--accent)',
          textTransform: 'uppercase', fontFamily: 'inherit', outline: 0,
        }}/>
    );
  }
  return (
    <button onClick={() => setEditing(true)} style={{
      display: 'inline-block', padding: '0 4px', borderRadius: 4, border: 0, cursor: 'pointer',
      background: 'var(--accent-soft)', color: 'var(--accent)',
      fontSize: 11, fontWeight: 700, fontFamily: 'inherit', textTransform: 'uppercase',
    }}>{value}</button>
  );
}
