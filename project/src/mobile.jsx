// Mobile dashboard — clean slate.

function MobileDashboard({ direction }) {
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <div style={{
      background: 'var(--page)', color: 'var(--fg)',
      minHeight: '100%', paddingBottom: 100,
      fontFamily: 'var(--font-sans)',
    }}>
      <div style={{ height: 56 }} />

      <div style={{ padding: '8px 20px 16px' }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{dateStr}</div>
        <h1 className="page-title" style={{ fontSize: 28, margin: '6px 0 0', letterSpacing: '-0.03em' }}>
          {greet}
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.45 }}>
          Welcome to THRYVE.
        </p>
      </div>

      {/* Ivy card */}
      <div style={{ padding: '0 16px 16px' }}>
        <div style={{
          padding: 14, borderRadius: 14,
          background: 'linear-gradient(135deg, var(--accent-soft), var(--surface))',
          border: '1px solid var(--border)',
          display: 'flex', gap: 12, alignItems: 'flex-start',
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 10,
            background: `linear-gradient(135deg, var(--accent), ${direction==='bold'?'#E5FF80':'#5966B8'})`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--accent-ink)', flexShrink: 0,
          }}><Icons.Spark size={16} sw={2}/></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, marginBottom: 2, letterSpacing: '0.05em' }}>IVY</div>
            <div style={{ fontSize: 13.5, fontWeight: 550, lineHeight: 1.35, marginBottom: 4 }}>
              Let&rsquo;s get you set up
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.45 }}>
              I can pull clients from your email and draft your first welcome note.
            </div>
          </div>
        </div>
      </div>

      {/* Empty sections */}
      <div style={{ padding: '0 16px 16px' }}>
        <div className="card" style={{ padding: 20 }}>
          <div className="metric-label" style={{ marginBottom: 10 }}>Today</div>
          <EmptyNote icon="Calendar" title="No sessions" hint="Share your booking link." />
        </div>
      </div>

      <div style={{ padding: '0 16px 16px' }}>
        <div className="card" style={{ padding: 20 }}>
          <div className="metric-label" style={{ marginBottom: 10 }}>Clients</div>
          <EmptyNote icon="Users" title="No clients yet" hint="Add your first one to get started." />
        </div>
      </div>

      {/* Bottom tab bar */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        padding: '8px 20px 32px',
        background: 'color-mix(in oklab, var(--surface) 85%, transparent)',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--border)',
        display: 'flex', justifyContent: 'space-around', alignItems: 'center',
      }}>
        {[
          { i: 'Home',     active: true },
          { i: 'Users',    active: false },
          { i: 'Calendar', active: false },
          { i: 'Chat',     active: false },
          { i: 'Spark',    active: false, accent: true },
        ].map(({i, active, accent}, idx) => {
          const I = Icons[i];
          return (
            <button key={idx} style={{
              padding: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
              color: active ? 'var(--fg)' : (accent ? 'var(--accent)' : 'var(--muted)'),
            }}>
              <I size={20} sw={active ? 2 : 1.7} />
              {active && <span style={{
                width: 4, height: 4, borderRadius: 99, background: 'var(--accent)',
              }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

window.MobileDashboard = MobileDashboard;
