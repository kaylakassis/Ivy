// /me - the client's home. In order:
//   1. A greeting.
//   2. "Next appointment" (service, business, when, where, Add to calendar,
//      Reschedule, Message) or, with nothing booked, "Book again with
//      <business>".
//   3. "Needs your attention", only when something does: unpaid invoices
//      (Pay), documents to sign (Sign), unread messages, program lessons
//      waiting, visits to review. Each with one direct action.
//   4. "Your businesses": logo, name, Book, Message, their packages and
//      programs; Hide sits in a small menu.
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icons } from '../../components/Icons.jsx';
import { SkelLine, SkelBlock, SkelRowList } from '../../components/Skeleton.jsx';
import { useClientPortal } from './clientContext.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { api } from '../../lib/api.js';
import { usePullRefresh } from '../../lib/pullRefresh.js';
import { ArchivedBadge, ArchivedNotice } from '../../components/ArchivedBusiness.jsx';
import { whereLine } from './ClientBookings.jsx';
import {
  fmtDay, fmtLongDay, fmtTimeRange, fmtMoney, relativeDay, bookHref, plural,
  BusinessAvatar, SectionTitle, MenuButton, AddToCalendarMenu, EmptyCard, actionBtn, actionRow,
} from './portalUi.jsx';

export default function ClientHome() {
  const { data, loading, error, refresh } = useClientPortal();
  const { user } = useAuth();
  const [extra, setExtra] = useState(null); // { bookings, invoices, documents, programs, packages }

  const summary = data?.summary;
  const isClient = !!data?.isClient;
  const wantInvoices = (summary?.openInvoices || 0) > 0;
  const wantDocs = (summary?.pendingDocs || 0) > 0;

  const loadExtra = useCallback(async () => {
    if (!isClient) { setExtra({ bookings: null, invoices: [], documents: [], programs: [], packages: [] }); return; }
    const soft = (p, fb) => p.catch(() => fb);
    const [bookings, invoices, documents, programs, packages] = await Promise.all([
      soft(api.get('/me/bookings'), null),
      wantInvoices ? soft(api.get('/me/invoices'), { invoices: [] }) : { invoices: [] },
      wantDocs ? soft(api.get('/me/documents'), { documents: [] }) : { documents: [] },
      soft(api.get('/me/programs'), { programs: [] }),
      soft(api.get('/me/packages'), { packages: [] }),
    ]);
    setExtra({
      bookings,
      invoices: (invoices.invoices || []).filter((i) => i.status === 'sent' || i.status === 'overdue'),
      documents: (documents.documents || []).filter((d) => d.status === 'sent'),
      programs: programs.programs || [],
      packages: packages.packages || [],
    });
  }, [isClient, wantInvoices, wantDocs]);

  // Reload when the counts that decide what to fetch change (the shell
  // refreshes /api/me on every navigation; identical counts = no refetch).
  const hasData = !!data;
  useEffect(() => { if (hasData) loadExtra(); }, [hasData, loadExtra]);
  usePullRefresh(() => loadExtra());

  if (loading || (!data && !error)) return <HomeSkeleton/>;
  if (error || !data) {
    return (
      <div className="page-pad"><div className="portal-page">
        <EmptyCard icon="Home" title="We couldn't load your home page"
          hint="Check your connection and try again."
          action={<button className="btn btn-primary" onClick={() => refresh().catch(() => {})} style={actionBtn}>Try again</button>}/>
      </div></div>
    );
  }

  const first = (user?.name || data.user?.name || '').trim().split(/\s+/)[0];
  const { memberships } = data;

  return (
    <div className="page-pad"><div className="portal-page">
      <FirstVisitWelcome/>
      <div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4, letterSpacing: '0.04em' }}>
          {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        </div>
        <h2 className="page-title" style={{ margin: 0, fontSize: 'clamp(26px, 6vw, 34px)', lineHeight: 1.15 }}>
          {greeting()}{first ? `, ${first}` : ''}
        </h2>
      </div>

      {!isClient ? (
        <EmptyCard icon="Users" title="No businesses here yet"
          hint={user?.email_verified_at || data.user?.emailVerifiedAt
            ? `When a business adds you as a client, or you book through their Ivy page, they show up here. Use the same email they have for you (${data.user?.email || user?.email}).`
            : `If a business already added you, confirm your email (${data.user?.email || user?.email}) to see them here. Check your inbox for our link, then pull down to refresh.`}
          action={<Link to="/me/discover" className="btn btn-primary" style={actionBtn}><Icons.Globe size={14}/> Find a business</Link>}/>
      ) : (
        <>
          {!extra ? <SkelBlock height={170} radius={16}/> : (
            <NextUp bookings={extra.bookings} memberships={memberships}/>
          )}
          {extra && <Attention summary={summary} extra={extra}/>}
          <Businesses memberships={memberships} extra={extra}/>
        </>
      )}
    </div></div>
  );
}

function HomeSkeleton() {
  return (
    <div className="page-pad"><div className="portal-page" aria-busy="true" aria-label="Loading">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SkelLine width={160} height={12}/>
        <SkelLine width={240} height={28} style={{ borderRadius: 8 }}/>
      </div>
      <SkelBlock height={170} radius={16}/>
      <SkelRowList rows={2} withAvatar/>
    </div></div>
  );
}

// ── Next appointment, or Book again ─────────────────────────────────────
function NextUp({ bookings, memberships }) {
  if (!bookings) return null; // bookings failed to load: say nothing rather than "nothing booked"
  const upcoming = bookings.upcoming || [];
  const next = upcoming[0];
  if (next) return <NextAppointment b={next} more={upcoming.length - 1}/>;

  // Nothing booked: suggest the business they saw most recently.
  const last = (bookings.past || []).find((b) => b.bizSlug && !b.archived);
  const fallback = !last && memberships.find((m) => m.bookingSlug && !m.archived);
  if (!last && !fallback) return null;
  const name = last ? last.businessName : fallback.businessName;
  const logo = memberships.find((m) => m.clientId === (last?.clientId || fallback?.clientId))?.logoUrl;
  return (
    <section className="card" style={{ padding: 18 }} aria-label="Book again">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <BusinessAvatar name={name} logoUrl={logo} size={44}/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Nothing booked right now</div>
          <div style={{ fontSize: 17, fontWeight: 650, overflowWrap: 'anywhere' }}>Book again with {name}</div>
        </div>
      </div>
      {last && (
        <div style={{ fontSize: 13.5, color: 'var(--fg-2)', marginTop: 10 }}>
          Your last visit: {last.serviceName || 'Appointment'} on {fmtDay(last.date)}
        </div>
      )}
      <div style={actionRow}>
        {last?.serviceId && last.serviceName ? (
          <Link to={bookHref(last.bizSlug, last.serviceId)} className="btn btn-primary" style={actionBtn}>
            <Icons.Repeat size={14} sw={1.8}/> Book {last.serviceName} again
          </Link>
        ) : (
          <Link to={bookHref(last?.bizSlug || fallback.bookingSlug)} className="btn btn-primary" style={actionBtn}>
            <Icons.Calendar size={14} sw={1.8}/> Book a time
          </Link>
        )}
        {last?.serviceId && (
          <Link to={bookHref(last.bizSlug)} className="btn btn-outline" style={actionBtn}>See all services</Link>
        )}
      </div>
    </section>
  );
}

function NextAppointment({ b, more }) {
  const rel = relativeDay(b.date);
  const where = whereLine(b);
  const canMove = !!b.bizSlug && !!b.serviceId && !b.recurrenceRule && !b.archived;
  return (
    <section className="card" aria-label="Next appointment" style={{
      padding: 18, borderColor: 'color-mix(in srgb, var(--accent) 55%, var(--border))',
      background: 'color-mix(in srgb, var(--accent-soft) 40%, var(--surface))',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--accent)' }}>
          Next appointment
        </span>
        {rel && (
          <span style={{
            fontSize: 12, fontWeight: 650, padding: '2px 9px', borderRadius: 99,
            background: 'var(--accent)', color: 'var(--accent-ink)',
          }}>{rel}</span>
        )}
      </div>
      <div style={{ fontSize: 20, fontWeight: 650, lineHeight: 1.25, overflowWrap: 'anywhere' }}>{b.serviceName || 'Appointment'}</div>
      <div style={{ fontSize: 14.5, color: 'var(--fg-2)', marginTop: 2, overflowWrap: 'anywhere' }}>with {b.businessName}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12, fontSize: 14.5 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Icons.Calendar size={16} sw={1.8} stroke="var(--accent)"/>
          <span>{fmtLongDay(b.date)}<br/><span style={{ color: 'var(--fg-2)' }}>{fmtTimeRange(b.startMin, b.endMin)}</span></span>
        </div>
        {where && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            {b.videoRoomUrl ? <Icons.Globe size={16} sw={1.8} stroke="var(--accent)"/> : <Icons.Home size={16} sw={1.8} stroke="var(--accent)"/>}
            <span style={{ overflowWrap: 'anywhere' }}>{where}</span>
          </div>
        )}
      </div>
      <div style={actionRow}>
        {b.videoRoomUrl && (
          <a href={b.videoRoomUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primary" style={actionBtn}>
            <Icons.Globe size={14} sw={1.8}/> Join video call
          </a>
        )}
        <AddToCalendarMenu links={b.calendar}/>
        {canMove && (
          <Link to={`/me/bookings?reschedule=${encodeURIComponent(b.id)}`} className="btn btn-outline" style={actionBtn}>
            <Icons.Clock size={14} sw={1.8}/> Reschedule
          </Link>
        )}
        {!b.archived && (
          <Link to={`/me/messages?clientId=${encodeURIComponent(b.clientId)}`} className="btn btn-outline" style={actionBtn}>
            <Icons.Chat size={14} sw={1.8}/> Message
          </Link>
        )}
      </div>
      {more > 0 && (
        <Link to="/me/bookings" style={{ display: 'inline-block', marginTop: 12, fontSize: 13.5, color: 'var(--accent)', fontWeight: 600 }}>
          See all {more + 1} upcoming bookings
        </Link>
      )}
    </section>
  );
}

// ── Needs your attention ────────────────────────────────────────────────
function Attention({ summary, extra }) {
  const [opening, setOpening] = useState(null);
  const [err, setErr] = useState(null);
  const openLink = async (kind, id) => {
    setOpening(id); setErr(null);
    try {
      const r = await api.post(`/me/${kind}/${id}/access-link`);
      window.open(r.url, '_blank', 'noopener');
    } catch (e) {
      setErr(e.message || 'Could not open it. Please try again.');
    } finally {
      setOpening(null);
    }
  };

  const items = [];
  for (const inv of extra.invoices.slice(0, 3)) {
    const due = inv.amountDue > 0 ? inv.amountDue : inv.total;
    items.push({
      key: 'inv' + inv.id, icon: 'Dollar', tone: inv.status === 'overdue' ? 'danger' : 'warn',
      title: `${fmtMoney(due, inv.currency)} to pay ${inv.businessName}`,
      sub: inv.status === 'overdue' ? `Overdue · Invoice ${inv.number}` : `Invoice ${inv.number}${inv.dueDate ? ` · due ${fmtDay(inv.dueDate)}` : ''}`,
      action: <button className="btn btn-primary" style={actionBtn} disabled={opening === inv.id} onClick={() => openLink('invoices', inv.id)}>{opening === inv.id ? 'Opening…' : 'Pay'}</button>,
    });
  }
  if (extra.invoices.length > 3) {
    items.push({ key: 'inv-more', icon: 'Dollar', tone: 'warn', title: `${extra.invoices.length - 3} more to pay`,
      action: <Link to="/me/invoices" className="btn btn-outline" style={actionBtn}>See all</Link> });
  }
  for (const d of extra.documents.slice(0, 3)) {
    items.push({
      key: 'doc' + d.id, icon: 'Doc', tone: 'warn',
      title: `Sign "${d.name}"`, sub: `From ${d.businessName}`,
      action: <button className="btn btn-primary" style={actionBtn} disabled={opening === d.id} onClick={() => openLink('documents', d.id)}>{opening === d.id ? 'Opening…' : 'Sign'}</button>,
    });
  }
  if (extra.documents.length > 3) {
    items.push({ key: 'doc-more', icon: 'Doc', tone: 'warn', title: `${extra.documents.length - 3} more to sign`,
      action: <Link to="/me/documents" className="btn btn-outline" style={actionBtn}>See all</Link> });
  }
  if (summary.unreadMessages > 0) {
    items.push({
      key: 'msg', icon: 'Chat', tone: 'accent', title: `${plural(summary.unreadMessages, 'new message')}`,
      action: <Link to="/me/messages" className="btn btn-primary" style={actionBtn}>Read</Link>,
    });
  }
  for (const p of extra.programs.filter((x) => x.items > 0 && (x.completedCount || 0) < x.items).slice(0, 2)) {
    const left = p.items - (p.completedCount || 0);
    items.push({
      key: 'prog' + p.id, icon: 'Trophy', tone: 'accent',
      title: `${plural(left, 'lesson')} waiting in ${p.title}`, sub: `From ${p.businessName}`,
      action: <Link to={`/me/programs/${p.id}`} className="btn btn-outline" style={actionBtn}>Continue</Link>,
    });
  }
  if (summary.pendingReviews > 0) {
    items.push({
      key: 'rev', icon: 'Star', tone: 'accent',
      title: summary.pendingReviews === 1 ? 'How was your last visit?' : `${summary.pendingReviews} visits to review`,
      sub: 'A quick rating helps the business',
      action: <Link to="/me/bookings?tab=past" className="btn btn-outline" style={actionBtn}>Review</Link>,
    });
  }
  if (items.length === 0) return null;

  return (
    <section aria-label="Needs your attention">
      <SectionTitle>Needs your attention</SectionTitle>
      {err && <div role="alert" style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 8 }}>{err}</div>}
      <div className="card" style={{ overflow: 'hidden' }}>
        {items.map((it, i) => {
          const I = Icons[it.icon] || Icons.Bell;
          const color = it.tone === 'danger' ? 'var(--danger)' : it.tone === 'warn' ? 'var(--warn)' : 'var(--accent)';
          return (
            <div key={it.key} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', flexWrap: 'wrap',
              borderTop: i === 0 ? 'none' : '1px solid var(--border)',
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                background: `color-mix(in srgb, ${color} 14%, var(--surface))`, color,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}><I size={17} sw={1.8}/></div>
              <div style={{ flex: '1 1 150px', minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 600, overflowWrap: 'anywhere' }}>{it.title}</div>
                {it.sub && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 1, overflowWrap: 'anywhere' }}>{it.sub}</div>}
              </div>
              <div style={{ flexShrink: 0, marginLeft: 'auto' }}>{it.action}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Your businesses ─────────────────────────────────────────────────────
function Businesses({ memberships, extra }) {
  const [err, setErr] = useState(null);
  const hide = async (m) => {
    if (!window.confirm(`Hide ${m.businessName} from your portal? Their bookings, invoices and messages will stop showing here. Nothing changes on their side.`)) return;
    try {
      await api.post('/me/businesses/hide', { clientId: m.clientId });
      window.location.reload();
    } catch (e) {
      setErr(e.message || 'Could not hide it. Please try again.');
    }
  };
  return (
    <section aria-label="Your businesses">
      <SectionTitle>Your businesses</SectionTitle>
      {err && <div role="alert" style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {memberships.map((m) => {
          // Matched by the business's public booking handle (packages) or
          // name (programs); those payloads carry no internal ids.
          const pkgs = (extra?.packages || []).filter((p) => (p.bookingSlug && p.bookingSlug === m.bookingSlug)
            || (!p.bookingSlug && p.businessName === m.businessName));
          const progs = (extra?.programs || []).filter((p) => p.businessName === m.businessName);
          return (
            <div key={m.clientId} className="card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <BusinessAvatar name={m.businessName} logoUrl={m.logoUrl} size={44}/>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 650, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', overflowWrap: 'anywhere' }}>
                    {m.businessName}
                    {m.archived && <ArchivedBadge/>}
                  </div>
                  {m.archived && <ArchivedNotice style={{ marginTop: 2 }}/>}
                </div>
                <MenuButton icon="More" ariaLabel={`More options for ${m.businessName}`} buttonClass="btn btn-ghost"
                  buttonStyle={{ padding: 8, minHeight: 36 }} align="right"
                  items={[{ label: 'Hide from my portal', icon: 'EyeOff', onClick: () => hide(m) }]}/>
              </div>
              {(pkgs.length > 0 || progs.length > 0) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
                  {pkgs.map((p) => (
                    <Link key={p.id} to="/me/invoices#packages" style={chip}>
                      <Icons.Gift size={14} sw={1.8} stroke="var(--accent)"/>
                      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{p.name}</span>
                      <span style={{ color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>{p.creditsRemaining} of {p.creditsTotal} left</span>
                    </Link>
                  ))}
                  {progs.map((p) => (
                    <Link key={p.id} to={`/me/programs/${p.id}`} style={chip}>
                      <Icons.Trophy size={14} sw={1.8} stroke="var(--accent)"/>
                      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{p.title}</span>
                      {p.items > 0 && <span style={{ color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>{p.progressPercent || 0}% done</span>}
                    </Link>
                  ))}
                </div>
              )}
              {!m.archived && (
                <div style={actionRow}>
                  {m.bookingSlug && (
                    <Link to={bookHref(m.bookingSlug)} className="btn btn-primary" style={actionBtn}>
                      <Icons.Calendar size={14} sw={1.8}/> Book
                    </Link>
                  )}
                  <Link to={`/me/messages?clientId=${encodeURIComponent(m.clientId)}`} className="btn btn-outline" style={actionBtn}>
                    <Icons.Chat size={14} sw={1.8}/> Message
                  </Link>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const chip = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 10,
  background: 'var(--surface-2)', border: '1px solid var(--border)',
  fontSize: 13.5, color: 'var(--fg)', textDecoration: 'none',
};

// One-time welcome note on the first visit (remembered in this browser).
const WELCOME_KEY = 'ivy.client.welcomed.v1';
function FirstVisitWelcome() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    try { if (!localStorage.getItem(WELCOME_KEY)) setVisible(true); } catch { /* storage blocked */ }
  }, []);
  if (!visible) return null;
  const dismiss = () => {
    try { localStorage.setItem(WELCOME_KEY, String(Date.now())); } catch { /* ignore */ }
    setVisible(false);
  };
  return (
    <div className="card" style={{
      padding: 16, display: 'flex', alignItems: 'flex-start', gap: 12,
      borderColor: 'var(--accent)',
      background: 'color-mix(in srgb, var(--accent-soft) 50%, var(--surface))',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 650, marginBottom: 4 }}>Welcome to Ivy</div>
        <p style={{ margin: '0 0 10px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Your bookings, payments and messages with every business you see, all in one place.
          Anything that needs you shows up right here.
        </p>
        <button onClick={dismiss} className="btn btn-primary" style={actionBtn}>Got it</button>
      </div>
      <button onClick={dismiss} aria-label="Dismiss" className="btn btn-ghost" style={{ padding: 6 }}>
        <Icons.X size={15}/>
      </button>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
