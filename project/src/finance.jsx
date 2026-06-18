// FINANCE - QuickBooks-lite for Ivy OS
// Store + FinanceView shell + Dashboard + Bank/Card accounts.
// Invoicing, templates, recurring → src/invoices.jsx

/* ============ STORE ============ */
const FIN_KEY = 'Ivy OS:finance';

function defaultFinance() {
  const now = Date.now();
  const D = 86400e3;
  return {
    fiscalStartMonth: 1, // January
    // Invoices
    invoices: [
      {
        id: 'inv-1001', number: 'INV-1001',
        clientId: 'c1', clientName: 'Ana Beltrán', clientEmail: 'ana@example.com',
        templateId: 'tpl-classic',
        issueDate: now - D * 12, dueDate: now - D * 5,
        items: [
          { id: 'li1', desc: 'Four-session coaching pack', qty: 4, rate: 120 },
          { id: 'li2', desc: 'Intake assessment', qty: 1, rate: 80 },
        ],
        taxRate: 0, discount: 0, notes: "Thanks for the commitment - let's do great work together.",
        status: 'paid', sentAt: now - D * 12, paidAt: now - D * 3, paidMethod: 'card',
        activity: [
          { ts: now - D * 12, kind: 'sent', text: 'Sent to Ana Beltrán' },
          { ts: now - D * 11, kind: 'viewed', text: 'Ana opened the invoice' },
          { ts: now - D * 3,  kind: 'paid',   text: 'Paid by card · $560.00' },
        ],
      },
      {
        id: 'inv-1002', number: 'INV-1002',
        clientId: 'c2', clientName: 'Jordan Cole', clientEmail: 'jordan@example.com',
        templateId: 'tpl-modern',
        issueDate: now - D * 7, dueDate: now + D * 7,
        items: [{ id: 'li1', desc: 'Monthly programming', qty: 1, rate: 240 }],
        taxRate: 0, discount: 0, notes: '',
        status: 'sent', sentAt: now - D * 7,
        activity: [
          { ts: now - D * 7, kind: 'sent',   text: 'Sent to Jordan Cole' },
          { ts: now - D * 5, kind: 'viewed', text: 'Jordan opened the invoice' },
        ],
      },
      {
        id: 'inv-1003', number: 'INV-1003',
        clientId: 'c5', clientName: 'Leah Park', clientEmail: 'leah@example.com',
        templateId: 'tpl-classic',
        issueDate: now - D * 21, dueDate: now - D * 7,
        items: [{ id: 'li1', desc: 'Studio membership - March', qty: 1, rate: 180 }],
        taxRate: 0, discount: 0, notes: '',
        status: 'overdue', sentAt: now - D * 21,
        activity: [
          { ts: now - D * 21, kind: 'sent',     text: 'Sent to Leah Park' },
          { ts: now - D * 18, kind: 'viewed',   text: 'Leah opened the invoice' },
          { ts: now - D * 7,  kind: 'overdue',  text: 'Invoice is overdue' },
        ],
      },
      {
        id: 'inv-1004', number: 'INV-1004',
        clientId: 'c3', clientName: 'Rina Okafor', clientEmail: 'rina@example.com',
        templateId: 'tpl-modern',
        issueDate: now - D * 34, dueDate: now - D * 20,
        items: [{ id: 'li1', desc: 'Quarterly coaching program', qty: 1, rate: 960 }],
        taxRate: 0, discount: 0, notes: '',
        status: 'paid', sentAt: now - D * 34, paidAt: now - D * 20, paidMethod: 'ach',
        activity: [
          { ts: now - D * 34, kind: 'sent', text: 'Sent to Rina Okafor' },
          { ts: now - D * 20, kind: 'paid', text: 'Paid by ACH · $960.00' },
        ],
      },
    ],
    nextInvoiceNumber: 1005,

    // Branded templates
    templates: [
      {
        id: 'tpl-classic', name: 'Classic',
        primary: '#1F2937', accent: '#0A8A4B', text: '#0A0B09',
        bg: '#FFFFFF', muted: '#7B7F75',
        fontDisplay: 'Fraunces', fontBody: 'Inter',
        header: 'left',    // 'left' | 'center' | 'banner'
        logoText: 'Your Business',
        terms: 'Payment due within 14 days. Thank you!',
      },
      {
        id: 'tpl-modern', name: 'Modern',
        primary: '#0A0B09', accent: '#D9FF4F', text: '#0A0B09',
        bg: '#ECEAE3', muted: '#6E6E68',
        fontDisplay: 'Instrument Serif', fontBody: 'Inter',
        header: 'banner',
        logoText: 'Your Business',
        terms: 'Net 14. Late payments accrue 1.5%/mo.',
      },
      {
        id: 'tpl-warm', name: 'Warm studio',
        primary: '#8C3D1F', accent: '#E8A758', text: '#2A1D14',
        bg: '#FAF3E7', muted: '#8A7562',
        fontDisplay: 'Fraunces', fontBody: 'Inter',
        header: 'center',
        logoText: 'Your Studio',
        terms: 'Thank you for supporting a small business.',
      },
    ],

    // Recurring schedules
    recurring: [
      {
        id: 'rec-1', clientId: 'c1', clientName: 'Ana Beltrán', clientEmail: 'ana@example.com',
        templateId: 'tpl-classic',
        items: [{ id: 'li1', desc: 'Monthly coaching retainer', qty: 1, rate: 480 }],
        taxRate: 0, discount: 0, notes: '',
        frequency: 'monthly', // weekly | biweekly | monthly | quarterly | yearly
        startDate: now - D * 60,
        nextRun: now + D * 12,
        endDate: null,
        active: true,
        lastRun: now - D * 18,
      },
    ],

    // Connected bank/card accounts + transactions
    banks: [
      {
        id: 'bank-1', institution: 'Chase', name: 'Business Checking',
        mask: '4512', type: 'checking', balance: 12840.22,
        connectedAt: now - D * 95,
      },
      {
        id: 'bank-2', institution: 'American Express', name: 'Business Platinum',
        mask: '1008', type: 'credit', balance: -2145.08,
        connectedAt: now - D * 95,
      },
    ],
    transactions: generateTxns(now),
  };
}

function generateTxns(now) {
  const D = 86400e3;
  const txns = [];
  const expenseCats = [
    ['Rent', 'Studio rent', 1850, 'expense', 'bank-1'],
    ['Software', 'Acuity Scheduling', 28, 'expense', 'bank-2'],
    ['Software', 'Canva Pro', 14.99, 'expense', 'bank-2'],
    ['Supplies', 'Office supplies', 62.40, 'expense', 'bank-2'],
    ['Food', 'Coffee with lead', 18.50, 'expense', 'bank-2'],
    ['Travel', 'Uber to client', 22.30, 'expense', 'bank-2'],
    ['Marketing', 'Instagram ads', 75, 'expense', 'bank-2'],
    ['Fees', 'Stripe processing', 22.40, 'expense', 'bank-1'],
    ['Utilities', 'Internet', 89, 'expense', 'bank-1'],
  ];
  const incomeCats = [
    ['Income', 'Payment - Ana Beltrán',     560,  'income',  'bank-1'],
    ['Income', 'Payment - Rina Okafor',     960,  'income',  'bank-1'],
    ['Income', 'Payment - Chris Mendes',    240,  'income',  'bank-1'],
    ['Income', 'Payment - Walk-in session', 140,  'income',  'bank-1'],
    ['Income', 'Payment - Marcus Lee',      320,  'income',  'bank-1'],
  ];
  let day = 0;
  for (let i = 0; i < 40; i++) {
    day += Math.floor(Math.random() * 3) + 1;
    const cat = Math.random() < 0.3 ? incomeCats[i % incomeCats.length] : expenseCats[i % expenseCats.length];
    txns.push({
      id: 't'+i,
      ts: now - D * day,
      bankId: cat[4],
      type: cat[3],
      category: cat[0],
      merchant: cat[1],
      amount: cat[3] === 'income' ? cat[2] : -cat[2],
    });
  }
  return txns.sort((a, b) => b.ts - a.ts);
}

function loadFinance() {
  try { return JSON.parse(localStorage.getItem(FIN_KEY)) || defaultFinance(); }
  catch { return defaultFinance(); }
}
function saveFinance(s) {
  localStorage.setItem(FIN_KEY, JSON.stringify(s));
  try { window.dispatchEvent(new StorageEvent('storage', { key: FIN_KEY })); } catch {}
}
function useFinanceStore() {
  const [s, setS] = React.useState(loadFinance);
  React.useEffect(() => {
    const h = (e) => { if (e.key === FIN_KEY || e.key == null) setS(loadFinance()); };
    window.addEventListener('storage', h);
    return () => window.removeEventListener('storage', h);
  }, []);
  const update = (next) => { setS(next); saveFinance(next); };
  return [s, update];
}

/* ============ MATH HELPERS ============ */
function money(n, opts = {}) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n || 0);
  return sign + '$' + abs.toLocaleString('en-US', {
    minimumFractionDigits: opts.decimals == null ? 2 : opts.decimals,
    maximumFractionDigits: opts.decimals == null ? 2 : opts.decimals,
  });
}
function moneyShort(n) {
  const abs = Math.abs(n || 0);
  if (abs >= 1000) return (n < 0 ? '-' : '') + '$' + (abs/1000).toFixed(1) + 'k';
  return money(n, { decimals: 0 });
}
function invoiceSubtotal(inv) {
  return (inv.items || []).reduce((sum, it) => sum + (Number(it.qty)||0) * (Number(it.rate)||0), 0);
}
function invoiceTotal(inv) {
  const sub = invoiceSubtotal(inv);
  const afterDiscount = sub - (Number(inv.discount)||0);
  const tax = afterDiscount * ((Number(inv.taxRate)||0) / 100);
  return afterDiscount + tax;
}
function computeKPIs(store) {
  const paid = store.invoices.filter(i => i.status === 'paid');
  const outstanding = store.invoices.filter(i => i.status === 'sent' || i.status === 'overdue');
  const grossRevenue = paid.reduce((s, i) => s + invoiceTotal(i), 0);
  const outstandingAmt = outstanding.reduce((s, i) => s + invoiceTotal(i), 0);
  const expenses = store.transactions.filter(t => t.type === 'expense').reduce((s, t) => s + Math.abs(t.amount), 0);
  const incomeTx = store.transactions.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const netProfit = Math.max(grossRevenue, incomeTx) - expenses;
  return { grossRevenue, outstandingAmt, netProfit, expenses, incomeTx, paidCount: paid.length, outstandingCount: outstanding.length };
}

/* ============ DATE ============ */
function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateShort(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function daysFromNow(ts) {
  return Math.round((ts - Date.now()) / 86400e3);
}
function relative(ts) {
  const d = daysFromNow(ts);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  if (d > 0) return `in ${d} days`;
  return `${-d} days ago`;
}

/* ============ TOAST ============ */
const ToastCtx = React.createContext(() => {});
function ToastProvider({ children }) {
  const [toasts, setToasts] = React.useState([]);
  const push = React.useCallback((t) => {
    const id = Math.random().toString(36).slice(2, 8);
    setToasts(ts => [...ts, { ...t, id }]);
    setTimeout(() => setToasts(ts => ts.filter(x => x.id !== id)), t.duration || 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div style={{
        position: 'fixed', right: 24, bottom: 24, zIndex: 200,
        display: 'flex', flexDirection: 'column', gap: 10, pointerEvents: 'none',
      }}>
        {toasts.map(t => (
          <div key={t.id} className="card" style={{
            padding: '12px 16px', minWidth: 260, maxWidth: 360,
            display: 'flex', alignItems: 'flex-start', gap: 10, pointerEvents: 'auto',
            animation: 'toastIn 0.25s ease-out',
            boxShadow: '0 8px 28px rgba(10,12,8,0.15)',
          }}>
            <div style={{
              width: 22, height: 22, borderRadius: 99, flexShrink: 0, marginTop: 2,
              background: 'color-mix(in srgb, var(--ok) 18%, var(--surface-2))',
              color: 'var(--ok)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icons.Check size={13} sw={2.4}/>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t.title}</div>
              {t.body && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{t.body}</div>}
            </div>
          </div>
        ))}
      </div>
      <style>{`@keyframes toastIn { from { opacity: 0; transform: translateY(6px);} to { opacity: 1; transform: none; } }`}</style>
    </ToastCtx.Provider>
  );
}
function useToast() { return React.useContext(ToastCtx); }
window.FinanceToast = { useToast };

/* ============ MAIN VIEW ============ */
function FinanceView({ direction }) {
  const [tab, setTab] = React.useState(() => localStorage.getItem('Ivy OS:finance:tab') || 'dashboard');
  const switchTab = (t) => { setTab(t); localStorage.setItem('Ivy OS:finance:tab', t); };

  return (
    <ToastProvider>
      <div style={{ padding: '24px 32px 96px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 20 }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 32, letterSpacing: '-0.03em', margin: 0 }}>
              Finance
            </h2>
            <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
              Invoices, recurring billing, and connected accounts - all in one place.
            </div>
          </div>
        </div>

        <FinanceTabs tab={tab} setTab={switchTab} />

        {tab === 'dashboard'  && <FinanceDashboard />}
        {tab === 'invoices'   && <InvoicesTab />}
        {tab === 'templates'  && <TemplatesTab />}
        {tab === 'recurring'  && <RecurringTab />}
        {tab === 'accounts'   && <AccountsTab />}
      </div>
    </ToastProvider>
  );
}

function FinanceTabs({ tab, setTab }) {
  const tabs = [
    { id: 'dashboard', label: 'Dashboard', icon: 'Trending' },
    { id: 'invoices',  label: 'Invoices',  icon: 'Dollar' },
    { id: 'templates', label: 'Templates', icon: 'Edit' },
    { id: 'recurring', label: 'Recurring', icon: 'Clock' },
    { id: 'accounts',  label: 'Accounts',  icon: 'Bank' },
  ];
  return (
    <div style={{
      display: 'flex', gap: 6, borderBottom: '1px solid var(--border)', paddingBottom: 0,
      overflowX: 'auto',
    }}>
      {tabs.map(t => {
        const Ic = Icons[t.icon] || Icons.Dollar;
        const active = tab === t.id;
        return (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 16px 12px', border: 0, background: 'none',
            fontSize: 13.5, fontWeight: active ? 600 : 500,
            color: active ? 'var(--fg)' : 'var(--muted)',
            borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
            marginBottom: -1, cursor: 'pointer', whiteSpace: 'nowrap',
          }}>
            <Ic size={14} sw={1.7}/>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* ============ DASHBOARD ============ */
function FinanceDashboard() {
  const [store] = useFinanceStore();
  const kpi = computeKPIs(store);

  const recentInvoices = store.invoices.slice().sort((a,b) => (b.issueDate||0) - (a.issueDate||0)).slice(0, 5);
  const recentTxns = store.transactions.slice(0, 8);

  // 6-month cashflow (income vs expense per month)
  const monthly = buildMonthlyCashflow(store);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        <KpiCard
          label="Gross revenue" value={money(kpi.grossRevenue)}
          sub={`${kpi.paidCount} paid invoice${kpi.paidCount === 1 ? '' : 's'}`}
          tone="ok"
          icon={<Icons.Trending size={16} sw={1.8}/>}
        />
        <KpiCard
          label="Outstanding" value={money(kpi.outstandingAmt)}
          sub={`${kpi.outstandingCount} unpaid invoice${kpi.outstandingCount === 1 ? '' : 's'}`}
          tone={kpi.outstandingAmt > 0 ? 'warn' : 'neutral'}
          icon={<Icons.Clock size={16} sw={1.8}/>}
        />
        <KpiCard
          label="Net profit" value={money(kpi.netProfit)}
          sub={`${money(kpi.grossRevenue)} in · ${money(kpi.expenses)} out`}
          tone={kpi.netProfit >= 0 ? 'ok' : 'bad'}
          icon={<Icons.Dollar size={16} sw={1.8}/>}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 16 }}>
        <div className="card" style={{ padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <div className="metric-label">Cashflow · last 6 months</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                Imported from connected accounts
              </div>
            </div>
            <LegendDot color="var(--ok)" label="Income"/>
            <div style={{ width: 14 }}/>
            <LegendDot color="var(--muted-2)" label="Expenses"/>
          </div>
          <CashflowChart data={monthly}/>
        </div>

        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
            <div className="metric-label" style={{ flex: 1 }}>Ivy's read on this</div>
            <div style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 99,
              background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 600,
            }}>AI</div>
          </div>
          <IvyInsights kpi={kpi} store={store}/>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 16 }}>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
            <div className="metric-label" style={{ flex: 1 }}>Recent invoices</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {recentInvoices.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: 'var(--muted)' }}>No invoices yet.</div>
            ) : recentInvoices.map(inv => (
              <div key={inv.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 4px',
                borderBottom: '1px solid var(--border)',
              }}>
                <div style={{
                  width: 34, height: 34, borderRadius: 8, background: 'var(--surface-2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 700, color: 'var(--muted)',
                }}>INV</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{inv.clientName}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                    {inv.number} · {fmtDateShort(inv.issueDate)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{money(invoiceTotal(inv))}</div>
                  <InvoiceStatusChip status={inv.status} dueDate={inv.dueDate} size="sm"/>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
            <div className="metric-label" style={{ flex: 1 }}>Transactions</div>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>from your accounts</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {recentTxns.map(t => (
              <div key={t.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 4px',
                borderBottom: '1px solid var(--border)',
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 8,
                  background: t.type === 'income' ? 'color-mix(in srgb, var(--ok) 15%, var(--surface-2))' : 'var(--surface-2)',
                  color: t.type === 'income' ? 'var(--ok)' : 'var(--muted)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  {t.type === 'income' ? <Icons.ArrowDown size={13} sw={2} style={{ transform: 'rotate(180deg)' }}/> : <Icons.ArrowDown size={13} sw={2}/>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 550, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.merchant}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 1 }}>
                    {t.category} · {fmtDateShort(t.ts)}
                  </div>
                </div>
                <div style={{
                  fontSize: 13, fontWeight: 600,
                  color: t.type === 'income' ? 'var(--ok)' : 'var(--fg)',
                }}>
                  {t.type === 'income' ? '+' : ''}{money(t.amount)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, value, sub, tone = 'neutral', icon }) {
  const toneMap = {
    ok:      { pill: 'color-mix(in srgb, var(--ok) 15%, var(--surface))', ink: 'var(--ok)' },
    warn:    { pill: 'color-mix(in srgb, var(--warn) 15%, var(--surface))', ink: 'var(--warn)' },
    bad:     { pill: 'color-mix(in srgb, var(--bad) 15%, var(--surface))', ink: 'var(--bad)' },
    neutral: { pill: 'var(--surface-2)', ink: 'var(--muted)' },
  };
  const t = toneMap[tone] || toneMap.neutral;
  return (
    <div className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 10, background: t.pill,
          color: t.ink, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{icon}</div>
        <div className="metric-label" style={{ flex: 1 }}>{label}</div>
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 32, letterSpacing: '-0.02em', lineHeight: 1.05 }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{sub}</div>
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
      <span style={{ width: 8, height: 8, borderRadius: 99, background: color }}/>
      {label}
    </div>
  );
}

function buildMonthlyCashflow(store) {
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString([], { month: 'short' }), income: 0, expense: 0, ts: d.getTime() });
  }
  const keyFor = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}`;
  };
  store.transactions.forEach(t => {
    const m = months.find(mm => mm.key === keyFor(t.ts));
    if (!m) return;
    if (t.type === 'income') m.income += t.amount;
    else m.expense += Math.abs(t.amount);
  });
  // Include paid invoices as income too (if not already in txns)
  store.invoices.filter(i => i.status === 'paid' && i.paidAt).forEach(inv => {
    const m = months.find(mm => mm.key === keyFor(inv.paidAt));
    if (!m) return;
    m.income += invoiceTotal(inv) * 0.2; // blend a bit to avoid double-counting mock data
  });
  return months;
}

function CashflowChart({ data }) {
  const max = Math.max(1, ...data.map(d => Math.max(d.income, d.expense)));
  const height = 160;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height: height + 28, paddingTop: 4 }}>
      {data.map((d, i) => {
        const ih = Math.round((d.income / max) * height);
        const eh = Math.round((d.expense / max) * height);
        return (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height, width: '100%', justifyContent: 'center' }}>
              <div title={`Income ${money(d.income)}`} style={{
                width: '40%', height: ih, borderRadius: '4px 4px 0 0',
                background: 'var(--ok)', minHeight: d.income > 0 ? 3 : 0,
              }}/>
              <div title={`Expenses ${money(d.expense)}`} style={{
                width: '40%', height: eh, borderRadius: '4px 4px 0 0',
                background: 'var(--muted-2)', minHeight: d.expense > 0 ? 3 : 0, opacity: 0.65,
              }}/>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{d.label}</div>
          </div>
        );
      })}
    </div>
  );
}

function IvyInsights({ kpi, store }) {
  const insights = [];
  if (kpi.outstandingAmt > 0) {
    const overdue = store.invoices.filter(i => i.status === 'overdue');
    if (overdue.length) {
      insights.push({
        tone: 'warn',
        text: `${overdue.length} invoice${overdue.length === 1 ? '' : 's'} overdue (${money(overdue.reduce((s,i) => s+invoiceTotal(i), 0))}). I can send friendly reminders - one tap.`,
      });
    }
  }
  const subRev = store.invoices
    .filter(i => i.status === 'paid' && Date.now() - i.paidAt < 30 * 86400e3)
    .reduce((s, i) => s + invoiceTotal(i), 0);
  if (subRev > 0) {
    insights.push({ tone: 'ok', text: `You collected ${money(subRev)} in the last 30 days - ${subRev > 1000 ? 'strong month' : 'steady flow'}.` });
  }
  const biggestCat = {};
  store.transactions.filter(t => t.type === 'expense').forEach(t => {
    biggestCat[t.category] = (biggestCat[t.category] || 0) + Math.abs(t.amount);
  });
  const topCat = Object.entries(biggestCat).sort((a,b) => b[1]-a[1])[0];
  if (topCat) {
    insights.push({ tone: 'info', text: `Biggest expense category this period: ${topCat[0]} (${money(topCat[1])}).` });
  }
  if (store.recurring.some(r => r.active)) {
    const activeRec = store.recurring.filter(r => r.active).length;
    insights.push({ tone: 'info', text: `You have ${activeRec} recurring invoice${activeRec===1?'':'s'} scheduled - automated revenue.` });
  }
  if (insights.length === 0) {
    insights.push({ tone: 'info', text: 'Not enough data yet. Send your first invoice or connect an account to begin.' });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {insights.map((ins, i) => (
        <div key={i} style={{
          padding: '10px 12px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.5,
          background: ins.tone === 'warn' ? 'color-mix(in srgb, var(--warn) 10%, var(--surface))'
                   : ins.tone === 'ok'   ? 'color-mix(in srgb, var(--ok) 10%, var(--surface))'
                   : 'var(--surface-2)',
          border: '1px solid ' + (ins.tone === 'warn' ? 'color-mix(in srgb, var(--warn) 25%, var(--border))'
                   : ins.tone === 'ok'   ? 'color-mix(in srgb, var(--ok) 25%, var(--border))'
                   : 'var(--border)'),
          color: 'var(--fg-2)',
        }}>
          {ins.text}
        </div>
      ))}
    </div>
  );
}

/* ============ STATUS CHIP (shared with invoices.jsx) ============ */
function InvoiceStatusChip({ status, dueDate, size = 'md' }) {
  const padV = size === 'sm' ? 1 : 3;
  const padH = size === 'sm' ? 8 : 10;
  const fs = size === 'sm' ? 10.5 : 11.5;
  const map = {
    draft:    { bg: 'var(--surface-2)',                                      fg: 'var(--muted)', label: 'Draft' },
    sent:     { bg: 'color-mix(in srgb, var(--accent) 14%, var(--surface))', fg: 'var(--accent)', label: 'Sent' },
    viewed:   { bg: 'color-mix(in srgb, var(--accent) 14%, var(--surface))', fg: 'var(--accent)', label: 'Viewed' },
    paid:     { bg: 'color-mix(in srgb, var(--ok) 14%, var(--surface))',     fg: 'var(--ok)',     label: 'Paid' },
    overdue:  { bg: 'color-mix(in srgb, var(--bad) 14%, var(--surface))',    fg: 'var(--bad)',    label: 'Overdue' },
  };
  const s = map[status] || map.draft;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: `${padV}px ${padH}px`, borderRadius: 99,
      fontSize: fs, fontWeight: 600, background: s.bg, color: s.fg,
      marginTop: size === 'sm' ? 2 : 0,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: s.fg }}/>
      {s.label}
    </span>
  );
}

/* ============ ACCOUNTS TAB ============ */
function AccountsTab() {
  const [store, update] = useFinanceStore();
  const [connectOpen, setConnectOpen] = React.useState(false);
  const toast = useToast();

  const disconnect = (id) => {
    if (!confirm('Disconnect this account? Transactions will stop syncing.')) return;
    update({ ...store, banks: store.banks.filter(b => b.id !== id) });
    toast({ title: 'Disconnected', body: 'Account removed.' });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ padding: 20, display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12,
          background: 'color-mix(in srgb, var(--accent) 16%, var(--surface-2))',
          color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Bank size={20} sw={1.6}/>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>Connected accounts</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            Linked via bank-grade encryption. Balances and transactions sync automatically.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setConnectOpen(true)}>
          <Icons.Plus size={13} sw={2}/> Connect account
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
        {store.banks.map(b => (
          <div key={b.id} className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: b.type === 'credit' ? '#1E2A3E' : '#E7F0E7',
                color: b.type === 'credit' ? '#fff' : '#2A4A2A',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 700, fontSize: 12, letterSpacing: '0.04em',
              }}>{b.institution.slice(0, 3).toUpperCase()}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{b.institution}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{b.name} ···· {b.mask}</div>
              </div>
              <button className="btn btn-ghost" onClick={() => disconnect(b.id)} style={{ padding: 6 }} title="Disconnect">
                <Icons.X size={14}/>
              </button>
            </div>
            <div style={{
              padding: 14, borderRadius: 10, background: 'var(--surface-2)',
              border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>
                {b.type === 'credit' ? 'Balance' : 'Available'}
              </div>
              <div style={{
                fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 500, letterSpacing: '-0.02em',
                marginTop: 4, color: b.balance < 0 ? 'var(--bad)' : 'var(--fg)',
              }}>
                {money(b.balance)}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>
                Synced {fmtDateShort(Date.now() - 3600e3 * 2)} · auto-refresh every 4h
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
              <Icons.Check size={12} sw={2.2} stroke="var(--ok)"/>
              Connected {Math.round((Date.now() - b.connectedAt) / 86400e3)} days ago
            </div>
          </div>
        ))}
        <button onClick={() => setConnectOpen(true)} className="card" style={{
          padding: 20, border: '1px dashed var(--border-strong)', background: 'transparent',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 8, minHeight: 170, cursor: 'pointer', color: 'var(--muted)', fontSize: 13,
        }}>
          <Icons.Plus size={22} sw={1.8}/>
          Add another account
        </button>
      </div>

      {connectOpen && (
        <ConnectBankModal store={store} update={update} onClose={() => setConnectOpen(false)}/>
      )}
    </div>
  );
}

function ConnectBankModal({ store, update, onClose }) {
  const [step, setStep] = React.useState('pick'); // pick | auth | success
  const [bank, setBank] = React.useState(null);
  const [user, setUser] = React.useState('');
  const [pwd, setPwd] = React.useState('');
  const toast = useToast();

  const banks = [
    { name: 'Chase',              color: '#117ACA' },
    { name: 'Bank of America',    color: '#012169' },
    { name: 'Wells Fargo',        color: '#D71F28' },
    { name: 'Capital One',        color: '#D03027' },
    { name: 'American Express',   color: '#2E77BB' },
    { name: 'Citi',               color: '#004685' },
    { name: 'US Bank',            color: '#002F6C' },
    { name: 'Navy Federal',       color: '#003A70' },
    { name: 'Discover',           color: '#FF6000' },
    { name: 'Ally Bank',          color: '#7A0049' },
    { name: 'PNC',                color: '#F47920' },
    { name: 'Other',              color: '#555' },
  ];

  const authenticate = () => {
    setStep('connecting');
    setTimeout(() => {
      const newId = 'bank-' + Math.random().toString(36).slice(2, 7);
      const mask = Math.floor(1000 + Math.random() * 8999).toString();
      const newBank = {
        id: newId, institution: bank.name, name: 'Primary account',
        mask, type: 'checking', balance: Math.round(Math.random() * 15000 + 500),
        connectedAt: Date.now(),
      };
      update({ ...store, banks: [...store.banks, newBank] });
      setStep('success');
      setTimeout(() => {
        toast({ title: 'Account connected', body: `${bank.name} ···· ${mask}. Transactions will sync shortly.` });
        onClose();
      }, 1400);
    }, 1800);
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(10,12,8,0.5)', zIndex: 120,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div className="card" style={{ width: '100%', maxWidth: 520, padding: 28 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 18 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12, background: 'var(--accent-soft)',
            color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icons.Lock size={18} sw={1.7}/>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>
              Secure connection
            </div>
            <h3 style={{ margin: '3px 0 0', fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>
              {step === 'pick' ? 'Connect your bank or card' : step === 'success' ? 'Connected!' : `Sign in to ${bank?.name}`}
            </h3>
          </div>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}><Icons.X size={16}/></button>
        </div>

        {step === 'pick' && (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
              We use bank-level encryption. Your login is sent securely to your institution - Ivy OS never stores it.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              {banks.map(b => (
                <button key={b.name} onClick={() => { setBank(b); setStep('auth'); }} style={{
                  padding: 14, borderRadius: 12,
                  border: '1px solid var(--border)', background: 'var(--surface)',
                  cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8,
                  alignItems: 'flex-start', transition: 'all .15s',
                }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.background = 'var(--surface-2)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--surface)'; }}
                >
                  <div style={{
                    width: 30, height: 30, borderRadius: 8, background: b.color,
                    color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
                  }}>{b.name.slice(0,3).toUpperCase()}</div>
                  <div style={{ fontSize: 12.5, fontWeight: 550, textAlign: 'left' }}>{b.name}</div>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 'auth' && (
          <>
            <div style={{
              padding: 14, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12,
              background: 'var(--surface-2)', border: '1px solid var(--border)', marginBottom: 16,
            }}>
              <div style={{
                width: 34, height: 34, borderRadius: 8, background: bank.color, color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
              }}>{bank.name.slice(0,3).toUpperCase()}</div>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{bank.name}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Online banking login</div>
              </div>
            </div>
            <label style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>Username</label>
            <input value={user} onChange={e => setUser(e.target.value)}
              placeholder="you@bank.com" style={{
                width: '100%', padding: '10px 12px', borderRadius: 10,
                border: '1px solid var(--border-strong)', background: 'var(--surface)',
                color: 'var(--fg)', fontSize: 14, outline: 'none', marginBottom: 12,
              }}/>
            <label style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>Password</label>
            <input value={pwd} onChange={e => setPwd(e.target.value)} type="password"
              placeholder="••••••••" style={{
                width: '100%', padding: '10px 12px', borderRadius: 10,
                border: '1px solid var(--border-strong)', background: 'var(--surface)',
                color: 'var(--fg)', fontSize: 14, outline: 'none', marginBottom: 16,
              }}/>
            <div style={{
              padding: '10px 12px', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 8,
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 16,
            }}>
              <Icons.Lock size={12} sw={1.8}/>
              <span>256-bit encrypted · read-only access · can be revoked anytime</span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setStep('pick')}>Back</button>
              <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }}
                disabled={!user || !pwd} onClick={authenticate}>
                Connect securely
              </button>
            </div>
          </>
        )}

        {step === 'connecting' && (
          <div style={{ padding: '40px 20px', textAlign: 'center' }}>
            <div style={{
              width: 48, height: 48, borderRadius: 99, margin: '0 auto 18px',
              border: '3px solid var(--border)', borderTopColor: 'var(--accent)',
              animation: 'spin 0.8s linear infinite',
            }}/>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <div style={{ fontSize: 14, fontWeight: 550 }}>Signing you in to {bank?.name}…</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Verifying credentials · pulling accounts · fetching transactions
            </div>
          </div>
        )}

        {step === 'success' && (
          <div style={{ padding: '32px 20px', textAlign: 'center' }}>
            <div style={{
              width: 56, height: 56, borderRadius: 99, margin: '0 auto 16px',
              background: 'color-mix(in srgb, var(--ok) 15%, var(--surface-2))',
              color: 'var(--ok)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icons.Check size={28} sw={2.4}/>
            </div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Connected to {bank?.name}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>
              We're pulling in your recent transactions now.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============ INVOICES / TEMPLATES / RECURRING - imported from invoices.jsx ============ */
function InvoicesTab()  { return <window.InvoicesModule.List />; }
function TemplatesTab() { return <window.InvoicesModule.Templates />; }
function RecurringTab() { return <window.InvoicesModule.Recurring />; }

window.FinanceView = FinanceView;
window.Finance = {
  useFinanceStore, loadFinance, saveFinance,
  money, moneyShort, invoiceSubtotal, invoiceTotal, computeKPIs,
  fmtDate, fmtDateShort, daysFromNow, relative,
  InvoiceStatusChip,
};
