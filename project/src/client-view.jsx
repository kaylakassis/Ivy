// Client-side app: people who BOOK WITH businesses that use THRYVE.
// Free. Browse businesses, manage appointments, view payments, complete documents.

function ClientApp({ direction }) {
  const [tab, setTab] = React.useState(() => localStorage.getItem('thryve:client-tab') || 'home');
  React.useEffect(() => { localStorage.setItem('thryve:client-tab', tab); }, [tab]);

  const tabs = [
    { id: 'home',     label: 'Discover',    icon: 'Search' },
    { id: 'bookings', label: 'Appointments',icon: 'Calendar' },
    { id: 'payments', label: 'Payments',    icon: 'Dollar' },
    { id: 'docs',     label: 'Documents',   icon: 'Doc' },
    { id: 'messages', label: 'Messages',    icon: 'Chat' },
  ];

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <ClientSidebar tabs={tabs} current={tab} onNav={setTab} direction={direction} />
      <main style={{ flex: 1, minWidth: 0 }}>
        <ClientTopbar direction={direction} />
        <div style={{ padding: '28px 40px 64px', maxWidth: 1180, margin: '0 auto' }}>
          {tab === 'home'     && <ClientDiscover direction={direction} onOpenBooking={() => setTab('bookings')} />}
          {tab === 'bookings' && <ClientBookings direction={direction} />}
          {tab === 'payments' && <ClientPayments direction={direction} />}
          {tab === 'docs'     && <ClientDocs     direction={direction} />}
          {tab === 'messages' && <ClientMessagesLive direction={direction} />}
        </div>
      </main>
    </div>
  );
}

function ClientSidebar({ tabs, current, onNav, direction }) {
  return (
    <aside style={{
      width: 248, minWidth: 248,
      background: 'var(--sidebar-bg)',
      borderRight: '1px solid var(--border)',
      padding: '18px 14px',
      display: 'flex', flexDirection: 'column', gap: 18,
      height: '100vh', position: 'sticky', top: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px' }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Logo size={20} color="currentColor" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
          <span style={{
            fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 18,
            letterSpacing: '-0.01em', color: 'var(--sidebar-fg)',
          }}>thryve</span>
          <span style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            for clients
          </span>
        </div>
        <span style={{
          marginLeft: 'auto', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
          color: 'var(--ok)', textTransform: 'uppercase',
        }}>Free</span>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {tabs.map(t => {
          const I = Icons[t.icon];
          const active = current === t.id;
          return (
            <div key={t.id} className={`nav-item ${active ? 'active' : ''}`} onClick={() => onNav(t.id)}>
              <I size={17} sw={active ? 1.8 : 1.5} />
              <span>{t.label}</span>
            </div>
          );
        })}
      </nav>

      <div style={{ flex: 1 }} />

      <div style={{
        padding: 12, borderRadius: 12,
        background: 'var(--surface)', border: '1px solid var(--border)',
        fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.5,
      }}>
        <div style={{ fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>Run a business?</div>
        THRYVE is free for clients. If you serve clients, try the Business workspace — 28-day free trial.
        <button className="btn btn-outline" style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}
          onClick={() => {
            localStorage.setItem('thryve:view', 'business');
            location.reload();
          }}>
          Switch to Business
        </button>
      </div>
    </aside>
  );
}

function ClientTopbar({ direction }) {
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 16,
      padding: '22px 40px 18px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--page)', position: 'sticky', top: 0, zIndex: 40,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>Your THRYVE account</div>
        <div style={{ fontSize: 20, fontFamily: 'var(--font-display)', fontWeight: 500, letterSpacing: '-0.02em' }}>
          Welcome back
        </div>
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 11px', borderRadius: 10,
        background: 'var(--surface)', border: '1px solid var(--border)', minWidth: 280,
      }}>
        <Icons.Search size={15} stroke="var(--muted)" sw={1.6} />
        <input placeholder="Search businesses, services, cities…" style={{
          background: 'none', border: 0, outline: 'none', fontSize: 13, color: 'var(--fg)', flex: 1,
        }} />
      </div>
      <button className="btn btn-outline"><Icons.Bell size={15} /></button>
      <div style={{
        width: 34, height: 34, borderRadius: 99,
        background: 'var(--surface-2)', border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 600, color: 'var(--fg-2)',
      }}>
        <Icons.Users size={15} />
      </div>
    </header>
  );
}

/* ---------- Discover ---------- */

const SAMPLE_BUSINESSES = [
  { id: 1, name: 'Meridian Pilates', category: 'Pilates studio',     city: 'Austin, TX',   price: '$45 / class',   rating: 4.9, reviews: 128, accent: '#C8D8FF', book: true },
  { id: 2, name: 'Cove Dermatology', category: 'Medical skincare',   city: 'Austin, TX',   price: '$180 / visit',  rating: 4.8, reviews: 412, accent: '#FFD6B8', book: true },
  { id: 3, name: 'Marisol Hair',     category: 'Hair & color',       city: 'Austin, TX',   price: '$120+ / cut',   rating: 5.0, reviews: 89,  accent: '#E8D8FF', book: true },
  { id: 4, name: 'Forge Strength',   category: 'Personal training',  city: 'Austin, TX',   price: '$85 / session', rating: 4.9, reviews: 201, accent: '#D0E8D0', book: true },
  { id: 5, name: 'North & Oak CPA',  category: 'Accounting',         city: 'Remote',       price: 'Quote on call',  rating: 4.7, reviews: 54,  accent: '#FFE8B0', book: true },
  { id: 6, name: 'Juno Therapy',     category: 'Talk therapy',       city: 'Telehealth',   price: '$150 / session', rating: 4.9, reviews: 317, accent: '#FFD1DC', book: true },
];

function ClientDiscover({ direction, onOpenBooking }) {
  const [selected, setSelected] = React.useState(null);
  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h2 style={{
          fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 40,
          letterSpacing: '-0.03em', margin: '0 0 6px', lineHeight: 1.05,
        }}>
          Find a business.<br/>
          <span style={{ color: 'var(--muted)' }}>Book in two taps.</span>
        </h2>
        <p style={{ color: 'var(--fg-2)', fontSize: 15, maxWidth: 560, margin: 0 }}>
          Every business here runs on THRYVE, so your appointments, payments, and paperwork are all in one place.
        </p>
      </div>

      {/* Category chips */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
        {['All', 'Wellness', 'Beauty', 'Fitness', 'Health', 'Professional', 'Near me'].map((c, i) => (
          <button key={c} className="chip" style={{
            padding: '6px 14px', fontSize: 13,
            background: i === 0 ? 'var(--fg)' : 'var(--surface)',
            color: i === 0 ? 'var(--page)' : 'var(--fg-2)',
            borderColor: i === 0 ? 'var(--fg)' : 'var(--border)',
            cursor: 'pointer',
          }}>{c}</button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {SAMPLE_BUSINESSES.map(b => (
          <BusinessCard key={b.id} biz={b} onBook={() => setSelected(b)} />
        ))}
      </div>

      {selected && <BookingModal biz={selected} onClose={() => setSelected(null)} onDone={() => { setSelected(null); onOpenBooking && onOpenBooking(); }} />}
    </div>
  );
}

function BusinessCard({ biz, onBook }) {
  return (
    <div className="card" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        height: 120, background: biz.accent,
        display: 'flex', alignItems: 'flex-end', padding: 14,
        position: 'relative',
      }}>
        <div style={{
          position: 'absolute', top: 12, right: 12,
          padding: '4px 8px', borderRadius: 99,
          background: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: 600,
          color: '#333', display: 'flex', alignItems: 'center', gap: 4,
        }}>
          ★ {biz.rating}
        </div>
        <div style={{
          width: 48, height: 48, borderRadius: 12,
          background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '2px solid #fff', boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 20,
          color: '#333',
        }}>{biz.name[0]}</div>
      </div>
      <div style={{ padding: 16, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--fg)' }}>{biz.name}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>{biz.category} · {biz.city}</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
          <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>{biz.price}</span>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>{biz.reviews} reviews</span>
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12, justifyContent: 'center' }} onClick={onBook}>
          Book appointment
        </button>
      </div>
    </div>
  );
}

function BookingModal({ biz, onClose, onDone }) {
  const [step, setStep] = React.useState(1);
  const [service, setService] = React.useState(null);
  const [slot, setSlot] = React.useState(null);

  const services = [
    { id: 's1', name: 'Intro session',   dur: '45 min', price: '$45' },
    { id: 's2', name: 'Standard session',dur: '60 min', price: '$85' },
    { id: 's3', name: 'Full assessment', dur: '90 min', price: '$140' },
  ];
  const slots = ['Tue 9:00', 'Tue 11:30', 'Tue 2:00 pm', 'Wed 8:00', 'Wed 10:30', 'Wed 4:00 pm', 'Thu 9:30', 'Thu 1:00 pm'];

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(10, 12, 8, 0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
      padding: 20,
    }} onClick={onClose}>
      <div className="card" style={{
        width: '100%', maxWidth: 520, padding: 28, maxHeight: '90vh', overflow: 'auto',
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 22 }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12, background: biz.accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--font-display)', fontWeight: 600, color: '#333', fontSize: 20,
          }}>{biz.name[0]}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 2 }}>
              Booking · Step {step} of 3
            </div>
            <div style={{ fontWeight: 600, fontSize: 18 }}>{biz.name}</div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}>✕</button>
        </div>

        {step === 1 && (
          <div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10, fontWeight: 500 }}>Select service</div>
            {services.map(s => (
              <div key={s.id} onClick={() => setService(s)} style={{
                padding: 14, borderRadius: 10, marginBottom: 8, cursor: 'pointer',
                background: service?.id === s.id ? 'var(--accent-soft)' : 'var(--surface-2)',
                border: `1px solid ${service?.id === s.id ? 'var(--accent)' : 'var(--border)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <div>
                  <div style={{ fontWeight: 550 }}>{s.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{s.dur}</div>
                </div>
                <div style={{ fontFamily: 'var(--font-num)', fontWeight: 600 }}>{s.price}</div>
              </div>
            ))}
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 14 }}
              disabled={!service} onClick={() => setStep(2)}>Choose a time →</button>
          </div>
        )}

        {step === 2 && (
          <div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10, fontWeight: 500 }}>Pick a slot</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              {slots.map(s => (
                <button key={s} onClick={() => setSlot(s)} style={{
                  padding: '12px 10px', borderRadius: 8,
                  background: slot === s ? 'var(--accent)' : 'var(--surface-2)',
                  color: slot === s ? 'var(--accent-ink)' : 'var(--fg)',
                  border: `1px solid ${slot === s ? 'var(--accent)' : 'var(--border)'}`,
                  fontWeight: 500, fontSize: 14,
                }}>{s}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button className="btn btn-outline" onClick={() => setStep(1)} style={{ flex: 1, justifyContent: 'center' }}>← Back</button>
              <button className="btn btn-primary" disabled={!slot} onClick={() => setStep(3)} style={{ flex: 2, justifyContent: 'center' }}>
                Review →
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <div style={{ padding: 16, borderRadius: 10, background: 'var(--surface-2)', marginBottom: 14 }}>
              <Row label="Service" value={service.name} />
              <Row label="Duration" value={service.dur} />
              <Row label="When" value={slot} />
              <Row label="Total" value={service.price} bold />
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              Payment method on file will be charged only after your appointment. Free cancellation up to 24h before.
            </div>
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={onDone}>
              Confirm booking
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, bold }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', padding: '6px 0',
      fontSize: 14, fontWeight: bold ? 600 : 400,
      color: bold ? 'var(--fg)' : 'var(--fg-2)',
      borderTop: bold ? '1px solid var(--border)' : 'none',
      marginTop: bold ? 6 : 0,
    }}>
      <span style={{ color: 'var(--muted)', fontWeight: 400 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/* ---------- Bookings ---------- */

function ClientBookings({ direction }) {
  const upcoming = [
    { biz: 'Meridian Pilates',  service: 'Reformer intro', when: 'Tomorrow, 9:00 am', addr: '112 Congress Ave #4', status: 'Confirmed', accent: '#C8D8FF' },
    { biz: 'Juno Therapy',      service: 'Talk session',   when: 'Thu May 2, 3:30 pm',addr: 'Telehealth link',    status: 'Confirmed', accent: '#FFD1DC' },
  ];
  const past = [
    { biz: 'Forge Strength', service: 'Personal training', when: 'Apr 14', total: '$85' },
    { biz: 'Marisol Hair',   service: 'Color + cut',       when: 'Apr 2',  total: '$140' },
  ];

  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 32, letterSpacing: '-0.03em', margin: '0 0 24px' }}>
        Your appointments
      </h2>

      <h3 style={SECTION_H}>Upcoming</h3>
      <div style={{ display: 'grid', gap: 12, marginBottom: 36 }}>
        {upcoming.map((a, i) => (
          <div key={i} className="card" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{
              width: 56, height: 56, borderRadius: 12, background: a.accent,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--font-display)', fontWeight: 600, color: '#333', fontSize: 22, flexShrink: 0,
            }}>{a.biz[0]}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2, fontWeight: 500 }}>{a.when}</div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{a.service} · {a.biz}</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>{a.addr}</div>
            </div>
            <span className="chip chip-ok"><span className="chip-dot" />{a.status}</span>
            <button className="btn btn-outline">Reschedule</button>
          </div>
        ))}
      </div>

      <h3 style={SECTION_H}>Past</h3>
      <div className="card" style={{ overflow: 'hidden' }}>
        {past.map((a, i) => (
          <div key={i} style={{
            padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16,
            borderTop: i > 0 ? '1px solid var(--border)' : 'none',
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 550, fontSize: 14 }}>{a.service}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{a.biz} · {a.when}</div>
            </div>
            <span className="mono-num" style={{ fontSize: 14, color: 'var(--fg-2)' }}>{a.total}</span>
            <button className="btn btn-ghost" style={{ fontSize: 12 }}>Book again</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Payments ---------- */

function ClientPayments({ direction }) {
  const payments = [
    { biz: 'Forge Strength', date: 'Apr 14',  amt: '$85.00',  status: 'Paid', method: 'Visa · 4242' },
    { biz: 'Marisol Hair',   date: 'Apr 2',   amt: '$140.00', status: 'Paid', method: 'Visa · 4242' },
    { biz: 'Juno Therapy',   date: 'Mar 28',  amt: '$150.00', status: 'Paid', method: 'Visa · 4242' },
    { biz: 'Cove Dermatology', date: 'Mar 18',amt: '$180.00', status: 'Paid', method: 'Visa · 4242' },
  ];
  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 32, letterSpacing: '-0.03em', margin: '0 0 24px' }}>
        Payments
      </h2>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 28 }}>
        <div className="card" style={{ padding: 18 }}>
          <div className="metric-label">Spent in April</div>
          <div className="metric-value" style={{ fontSize: 36, marginTop: 8 }}>$555.00</div>
        </div>
        <div className="card" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 44, height: 28, borderRadius: 6,
            background: 'linear-gradient(135deg, #1a365d, #2d3748)', color: '#fff',
            fontSize: 10, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>VISA</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 550 }}>Visa ending in 4242</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Default · Expires 08/27</div>
          </div>
          <button className="btn btn-outline" style={{ fontSize: 12 }}>Manage</button>
        </div>
      </div>

      <h3 style={SECTION_H}>History</h3>
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr auto',
          padding: '10px 18px', borderBottom: '1px solid var(--border)',
          fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
          color: 'var(--muted)', fontWeight: 600,
        }}>
          <div>Business</div><div>Date</div><div>Method</div><div>Amount</div><div></div>
        </div>
        {payments.map((p, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr auto',
            padding: '14px 18px', alignItems: 'center', fontSize: 14,
            borderTop: i > 0 ? '1px solid var(--border)' : 'none',
          }}>
            <div style={{ fontWeight: 550 }}>{p.biz}</div>
            <div style={{ color: 'var(--fg-2)' }}>{p.date}</div>
            <div style={{ color: 'var(--fg-2)' }}>{p.method}</div>
            <div className="mono-num" style={{ fontWeight: 550 }}>{p.amt}</div>
            <button className="btn btn-ghost" style={{ fontSize: 12 }}>Receipt</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Docs ---------- */

function ClientDocs({ direction }) {
  const pending = [
    { name: 'Intake & health history', biz: 'Meridian Pilates', due: 'Due before tomorrow', fields: 12 },
    { name: 'Informed consent form',   biz: 'Juno Therapy',     due: 'Due before Thu', fields: 3 },
  ];
  const signed = [
    { name: 'Client agreement',       biz: 'Forge Strength',  date: 'Signed Apr 14' },
    { name: 'Cancellation policy',    biz: 'Marisol Hair',    date: 'Signed Apr 1' },
  ];
  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 32, letterSpacing: '-0.03em', margin: '0 0 24px' }}>
        Documents
      </h2>
      <h3 style={SECTION_H}>Action needed</h3>
      <div style={{ display: 'grid', gap: 12, marginBottom: 36 }}>
        {pending.map((d, i) => (
          <div key={i} className="card" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{
              width: 40, height: 48, borderRadius: 6,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}><Icons.Doc size={18} stroke="var(--accent)" /></div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 550 }}>{d.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{d.biz} · {d.fields} fields · {d.due}</div>
            </div>
            <button className="btn btn-primary">Complete →</button>
          </div>
        ))}
      </div>
      <h3 style={SECTION_H}>Signed & filed</h3>
      <div className="card" style={{ overflow: 'hidden' }}>
        {signed.map((d, i) => (
          <div key={i} style={{
            padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16,
            borderTop: i > 0 ? '1px solid var(--border)' : 'none',
          }}>
            <Icons.Doc size={17} stroke="var(--muted)" />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 550, fontSize: 14 }}>{d.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{d.biz} · {d.date}</div>
            </div>
            <button className="btn btn-ghost" style={{ fontSize: 12 }}>Download</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Messages ---------- */

function ClientMessages({ direction }) {
  const threads = [
    { biz: 'Meridian Pilates', last: "Looking forward to seeing you tomorrow! Please arrive 10 min early.", time: '2h', unread: true, accent: '#C8D8FF' },
    { biz: 'Juno Therapy',     last: "Here's the intake form — complete before our Thu session.", time: '1d', unread: true, accent: '#FFD1DC' },
    { biz: 'Forge Strength',   last: "Thanks for the session. Here's your program for the week.", time: '6d', unread: false, accent: '#D0E8D0' },
  ];
  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 32, letterSpacing: '-0.03em', margin: '0 0 24px' }}>
        Messages
      </h2>
      <div className="card" style={{ overflow: 'hidden' }}>
        {threads.map((t, i) => (
          <div key={i} style={{
            padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14,
            borderTop: i > 0 ? '1px solid var(--border)' : 'none', cursor: 'pointer',
          }}>
            <div style={{
              width: 40, height: 40, borderRadius: 12, background: t.accent,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--font-display)', fontWeight: 600, color: '#333', fontSize: 17,
            }}>{t.biz[0]}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{t.biz}</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>{t.time}</span>
              </div>
              <div style={{
                fontSize: 13, color: t.unread ? 'var(--fg)' : 'var(--muted)', marginTop: 3,
                fontWeight: t.unread ? 500 : 400,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{t.last}</div>
            </div>
            {t.unread && <div style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--accent)' }}/>}
          </div>
        ))}
      </div>
    </div>
  );
}

const SECTION_H = {
  fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase',
  color: 'var(--muted)', fontWeight: 600, margin: '0 0 10px',
};

window.ClientApp = ClientApp;
