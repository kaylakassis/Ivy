// Sidebar + Topbar

const { NAV } = window.THRYVE_DATA;

function Sidebar({ current, onNav, direction }) {
  return (
    <aside style={{
      width: 248, minWidth: 248,
      background: 'var(--sidebar-bg)',
      borderRight: '1px solid var(--border)',
      padding: '18px 14px',
      display: 'flex', flexDirection: 'column', gap: 18,
      height: '100vh', position: 'sticky', top: 0,
    }}>
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 6px' }}>
        <div style={{
          width: 30, height: 30, borderRadius: 8,
          background: direction === 'bold' ? 'var(--accent)' : 'var(--accent)',
          color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Logo size={20} color="currentColor" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
          <span style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 500, fontSize: 18, letterSpacing: '-0.01em',
            color: 'var(--sidebar-fg)',
          }}>thryve</span>
          <span style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {direction === 'bold' ? 'OS v2' : 'Business OS'}
          </span>
        </div>
      </div>

      {/* Workspace switcher */}
      <button style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', borderRadius: 10,
        background: 'var(--surface)', border: '1px dashed var(--border-strong)',
        textAlign: 'left', fontSize: 13, color: 'var(--fg-2)',
      }}>
        <div style={{
          width: 22, height: 22, borderRadius: 6,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          color: 'var(--muted)', fontSize: 11, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>+</div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ fontWeight: 550, color: 'var(--fg)', fontSize: 13, lineHeight: 1.1 }}>Name your workspace</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Untitled</div>
        </div>
        <Icons.ArrowDown size={14} stroke="var(--muted)" sw={1.8} />
      </button>

      {/* Nav */}
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV.map(item => {
          const IconComp = Icons[item.icon];
          const active = current === item.id;
          return (
            <div
              key={item.id}
              className={`nav-item ${active ? 'active' : ''}`}
              onClick={() => onNav(item.id)}
            >
              <IconComp size={17} sw={active ? 1.8 : 1.5} stroke={item.accent && !active ? 'var(--accent)' : 'currentColor'} />
              <span>{item.label}</span>
              {item.badge != null && <span className="nav-badge">{item.badge}</span>}
              {item.accent && !active && (
                <span style={{
                  marginLeft: 'auto', fontSize: 10, fontWeight: 600,
                  color: 'var(--accent)', letterSpacing: '0.06em',
                }}>NEW</span>
              )}
            </div>
          );
        })}
      </nav>

      <div style={{ flex: 1 }} />

      {/* Bottom: account */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '6px 6px',
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: 99,
          background: 'var(--surface)', border: '1px solid var(--border-strong)',
          color: 'var(--muted)', fontSize: 12, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Users size={14} stroke="var(--muted)" sw={1.6}/>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--sidebar-fg)', lineHeight: 1.1 }}>Add your profile</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Not signed in</div>
        </div>
        <button className="btn btn-ghost" style={{ padding: 6 }}><Icons.Settings size={15} /></button>
      </div>
    </aside>
  );
}

function Topbar({ title, subtitle, direction, toggleDirection, children }) {
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 16,
      padding: '22px 32px 18px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--page)',
      position: 'sticky', top: 0, zIndex: 40,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>
          <span>Workspace</span>
          <span>·</span>
          <span style={{ color: 'var(--fg-2)' }}>{title}</span>
        </div>
        <h1 className="page-title" style={{ margin: 0, fontSize: 28 }}>{subtitle || title}</h1>
      </div>

      {/* Search */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 11px', borderRadius: 10,
        background: 'var(--surface)', border: '1px solid var(--border)',
        minWidth: 280,
      }}>
        <Icons.Search size={15} stroke="var(--muted)" sw={1.6} />
        <input
          type="text" placeholder="Search clients, invoices, notes…"
          style={{
            background: 'none', border: 0, outline: 'none',
            fontSize: 13, color: 'var(--fg)',
            flex: 1,
          }}
        />
        <kbd style={{
          fontSize: 10, fontFamily: 'var(--font-sans)', fontWeight: 500,
          padding: '2px 5px', borderRadius: 4,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          color: 'var(--muted)',
        }}>⌘K</kbd>
      </div>

      <button className="btn btn-outline" style={{ position: 'relative' }}>
        <Icons.Bell size={15} />
        <span style={{
          position: 'absolute', top: 5, right: 5,
          width: 7, height: 7, borderRadius: 99,
          background: 'var(--accent)',
          border: '2px solid var(--surface)',
        }} />
      </button>

      {children}
    </header>
  );
}

window.Sidebar = Sidebar;
window.Topbar = Topbar;
