// INVOICES, TEMPLATES, RECURRING - mounted inside FinanceView tabs.
// Relies on window.Finance helpers from finance.jsx.

const { useFinanceStore, money, moneyShort, invoiceSubtotal, invoiceTotal,
        fmtDate, fmtDateShort, daysFromNow, relative, InvoiceStatusChip } = window.Finance;

/* ============ LIST ============ */
function InvoicesList() {
  const [store, update] = useFinanceStore();
  const [filter, setFilter] = React.useState('all');
  const [query, setQuery] = React.useState('');
  const [openInvoice, setOpenInvoice] = React.useState(null);
  const [creatorOpen, setCreatorOpen] = React.useState(false);

  const filters = [
    { id: 'all',       label: 'All' },
    { id: 'sent',      label: 'Unpaid' },
    { id: 'overdue',   label: 'Overdue' },
    { id: 'paid',      label: 'Paid' },
    { id: 'draft',     label: 'Drafts' },
  ];

  let rows = store.invoices.slice().sort((a,b) => (b.issueDate||0) - (a.issueDate||0));
  if (filter === 'sent')    rows = rows.filter(i => i.status === 'sent' || i.status === 'viewed');
  if (filter === 'overdue') rows = rows.filter(i => i.status === 'overdue');
  if (filter === 'paid')    rows = rows.filter(i => i.status === 'paid');
  if (filter === 'draft')   rows = rows.filter(i => i.status === 'draft');
  if (query.trim()) {
    const q = query.trim().toLowerCase();
    rows = rows.filter(i =>
      i.clientName.toLowerCase().includes(q) ||
      i.number.toLowerCase().includes(q) ||
      (i.items||[]).some(it => (it.desc||'').toLowerCase().includes(q))
    );
  }

  const counts = {
    all:     store.invoices.length,
    sent:    store.invoices.filter(i => i.status === 'sent' || i.status === 'viewed').length,
    overdue: store.invoices.filter(i => i.status === 'overdue').length,
    paid:    store.invoices.filter(i => i.status === 'paid').length,
    draft:   store.invoices.filter(i => i.status === 'draft').length,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Filter + search row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', padding: 4, borderRadius: 10 }}>
          {filters.map(f => {
            const active = filter === f.id;
            return (
              <button key={f.id} onClick={() => setFilter(f.id)} style={{
                padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 550,
                border: 0, cursor: 'pointer',
                background: active ? 'var(--surface)' : 'transparent',
                color: active ? 'var(--fg)' : 'var(--muted)',
                boxShadow: active ? '0 1px 3px rgba(10,12,8,0.06)' : 'none',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
                {f.label}
                <span style={{
                  fontSize: 10.5, padding: '1px 6px', borderRadius: 99,
                  background: active ? 'var(--surface-2)' : 'var(--surface)',
                  color: 'var(--muted)', fontWeight: 600,
                }}>{counts[f.id]}</span>
              </button>
            );
          })}
        </div>
        <div style={{ flex: 1 }}/>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '6px 12px', borderRadius: 10, background: 'var(--surface-2)',
          border: '1px solid var(--border)',
        }}>
          <Icons.Search size={13} sw={1.8} stroke="var(--muted)"/>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search invoices"
            style={{ border: 0, outline: 0, background: 'transparent', fontSize: 13, width: 160, color: 'var(--fg)' }}/>
        </div>
        <button className="btn btn-primary" onClick={() => setCreatorOpen(true)}>
          <Icons.Plus size={13} sw={2}/> New invoice
        </button>
      </div>

      {/* Table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '110px 1.4fr 100px 130px 130px 80px',
          padding: '12px 20px', fontSize: 10.5, letterSpacing: '0.08em',
          textTransform: 'uppercase', fontWeight: 600, color: 'var(--muted)',
          borderBottom: '1px solid var(--border)', background: 'var(--surface-2)',
        }}>
          <div>Number</div><div>Client</div><div>Status</div><div>Issued</div><div>Due</div>
          <div style={{ textAlign: 'right' }}>Amount</div>
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
            <Icons.Receipt size={28} sw={1.4}/>
            <div style={{ marginTop: 10, fontSize: 13 }}>No invoices match.</div>
          </div>
        ) : rows.map((inv, i) => (
          <button key={inv.id} onClick={() => setOpenInvoice(inv.id)} style={{
            display: 'grid', gridTemplateColumns: '110px 1.4fr 100px 130px 130px 80px',
            padding: '14px 20px', alignItems: 'center', width: '100%',
            border: 0, background: 'var(--surface)', cursor: 'pointer',
            borderTop: i === 0 ? 'none' : '1px solid var(--border)',
            textAlign: 'left', fontFamily: 'inherit',
            transition: 'background .1s',
          }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--surface-2)'}
            onMouseLeave={e => e.currentTarget.style.background = 'var(--surface)'}
          >
            <div style={{ fontSize: 12.5, fontWeight: 600, fontFeatureSettings: '"tnum"' }}>{inv.number}</div>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{inv.clientName}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: 300 }}>
                {(inv.items||[])[0]?.desc || '-'}
              </div>
            </div>
            <div><InvoiceStatusChip status={inv.status}/></div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{fmtDateShort(inv.issueDate)}</div>
            <div style={{ fontSize: 12.5, color: inv.status === 'overdue' ? 'var(--bad)' : 'var(--fg-2)' }}>
              {fmtDateShort(inv.dueDate)}
              {inv.status !== 'paid' && (
                <div style={{ fontSize: 10.5, color: inv.status === 'overdue' ? 'var(--bad)' : 'var(--muted)', marginTop: 1 }}>
                  {relative(inv.dueDate)}
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right', fontSize: 14, fontWeight: 600, fontFeatureSettings: '"tnum"' }}>
              {money(invoiceTotal(inv))}
            </div>
          </button>
        ))}
      </div>

      {openInvoice && (
        <InvoiceDetailDrawer
          invoiceId={openInvoice} onClose={() => setOpenInvoice(null)}
          store={store} update={update}/>
      )}
      {creatorOpen && (
        <InvoiceCreator onClose={() => setCreatorOpen(false)} store={store} update={update}/>
      )}
    </div>
  );
}

/* ============ CREATOR ============ */
function InvoiceCreator({ onClose, store, update, editing, isRecurring, onSaveRecurring }) {
  const toast = window.FinanceToast.useToast();
  const [client, setClient] = React.useState(editing?.clientId || '');
  const [templateId, setTemplateId] = React.useState(editing?.templateId || store.templates[0]?.id);
  const [items, setItems] = React.useState(editing?.items || [{ id: 'li' + Date.now(), desc: '', qty: 1, rate: 0 }]);
  const [taxRate, setTaxRate] = React.useState(editing?.taxRate || 0);
  const [discount, setDiscount] = React.useState(editing?.discount || 0);
  const [notes, setNotes] = React.useState(editing?.notes || '');
  const [issueDate, setIssueDate] = React.useState(editing?.issueDate ? new Date(editing.issueDate).toISOString().slice(0,10) : new Date().toISOString().slice(0,10));
  const [dueDate, setDueDate] = React.useState(editing?.dueDate ? new Date(editing.dueDate).toISOString().slice(0,10) : new Date(Date.now() + 14 * 86400e3).toISOString().slice(0,10));
  const [frequency, setFrequency] = React.useState(editing?.frequency || 'monthly');
  const [preview, setPreview] = React.useState(false);

  // Load clients from messages.jsx registry
  const [clients, setClients] = React.useState([]);
  React.useEffect(() => {
    try {
      const m = JSON.parse(localStorage.getItem('Ivy OS:messages'));
      setClients(m?.clients || []);
    } catch { setClients([]); }
  }, []);

  const template = store.templates.find(t => t.id === templateId) || store.templates[0];
  const selectedClient = clients.find(c => c.id === client);

  const invoicePreview = {
    number: editing?.number || `INV-${store.nextInvoiceNumber}`,
    clientName: selectedClient?.name || 'Client',
    clientEmail: selectedClient?.email || '',
    templateId, items, taxRate, discount, notes,
    issueDate: new Date(issueDate).getTime(),
    dueDate: new Date(dueDate).getTime(),
  };

  const addItem = () => setItems([...items, { id: 'li' + Date.now(), desc: '', qty: 1, rate: 0 }]);
  const updateItem = (id, patch) => setItems(items.map(it => it.id === id ? { ...it, ...patch } : it));
  const removeItem = (id) => setItems(items.length > 1 ? items.filter(it => it.id !== id) : items);

  const canSave = client && items.some(it => it.desc && it.rate > 0);

  const save = ({ send }) => {
    if (!canSave) return;
    if (isRecurring) {
      const rec = {
        id: editing?.id || 'rec-' + Date.now(),
        clientId: client, clientName: selectedClient.name, clientEmail: selectedClient.email,
        templateId, items, taxRate, discount, notes,
        frequency,
        startDate: new Date(issueDate).getTime(),
        nextRun: new Date(issueDate).getTime(),
        endDate: null, active: true, lastRun: null,
      };
      onSaveRecurring(rec);
      return;
    }
    const inv = {
      id: editing?.id || 'inv-' + Date.now(),
      number: invoicePreview.number,
      clientId: client, clientName: selectedClient.name, clientEmail: selectedClient.email,
      templateId, items, taxRate, discount, notes,
      issueDate: new Date(issueDate).getTime(),
      dueDate: new Date(dueDate).getTime(),
      status: send ? 'sent' : 'draft',
      sentAt: send ? Date.now() : undefined,
      activity: send ? [{ ts: Date.now(), kind: 'sent', text: `Sent to ${selectedClient.name}` }] : [],
    };
    const next = {
      ...store,
      invoices: editing
        ? store.invoices.map(i => i.id === editing.id ? inv : i)
        : [inv, ...store.invoices],
      nextInvoiceNumber: editing ? store.nextInvoiceNumber : store.nextInvoiceNumber + 1,
    };
    update(next);
    if (send) {
      // Push to messages thread
      postInvoiceMessage(inv);
      toast({ title: 'Invoice sent', body: `${inv.number} · ${money(invoiceTotal(inv))} → ${selectedClient.name}` });
    } else {
      toast({ title: 'Draft saved', body: inv.number });
    }
    onClose();
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(10,12,8,0.55)', zIndex: 110,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 1100, background: 'var(--surface)',
        borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '18px 28px', display: 'flex', alignItems: 'center', gap: 14,
          borderBottom: '1px solid var(--border)',
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {isRecurring ? <Icons.Repeat size={17} sw={1.7}/> : <Icons.Receipt size={17} sw={1.7}/>}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, color: 'var(--muted)' }}>
              {isRecurring ? (editing ? 'Edit recurring schedule' : 'New recurring schedule') : (editing ? 'Edit invoice' : 'New invoice')}
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em' }}>
              {invoicePreview.number}
            </div>
          </div>
          <button className="btn btn-outline" onClick={() => setPreview(p => !p)}>
            <Icons.Eye size={13} sw={1.8}/> {preview ? 'Edit' : 'Preview'}
          </button>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', display: 'grid', gridTemplateColumns: preview ? '1fr' : '1fr 1.15fr', minHeight: 0 }}>
          {!preview && (
            <div style={{ padding: 28, borderRight: '1px solid var(--border)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
              <Field label="Client">
                <select value={client} onChange={e => setClient(e.target.value)} style={selectStyle}>
                  <option value="">Choose a client…</option>
                  {clients.filter(c => c.registered).map(c => (
                    <option key={c.id} value={c.id}>{c.name} - {c.email}</option>
                  ))}
                </select>
              </Field>

              <Field label="Template">
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {store.templates.map(t => (
                    <button key={t.id} onClick={() => setTemplateId(t.id)} style={{
                      padding: '8px 14px', borderRadius: 10, cursor: 'pointer',
                      fontSize: 12.5, fontWeight: 550,
                      border: '1px solid ' + (t.id === templateId ? 'var(--accent)' : 'var(--border)'),
                      background: t.id === templateId ? 'var(--accent-soft)' : 'var(--surface)',
                      color: t.id === templateId ? 'var(--accent)' : 'var(--fg-2)',
                      display: 'inline-flex', alignItems: 'center', gap: 8,
                    }}>
                      <span style={{ width: 12, height: 12, borderRadius: 3, background: t.accent, border: `1px solid ${t.primary}` }}/>
                      {t.name}
                    </button>
                  ))}
                </div>
              </Field>

              <div style={{ display: 'grid', gridTemplateColumns: isRecurring ? '1fr 1fr' : '1fr 1fr', gap: 12 }}>
                <Field label={isRecurring ? 'Start date' : 'Issue date'}>
                  <input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} style={inputStyle}/>
                </Field>
                {isRecurring ? (
                  <Field label="Frequency">
                    <select value={frequency} onChange={e => setFrequency(e.target.value)} style={selectStyle}>
                      <option value="weekly">Weekly</option>
                      <option value="biweekly">Every 2 weeks</option>
                      <option value="monthly">Monthly</option>
                      <option value="quarterly">Quarterly</option>
                      <option value="yearly">Yearly</option>
                    </select>
                  </Field>
                ) : (
                  <Field label="Due date">
                    <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} style={inputStyle}/>
                  </Field>
                )}
              </div>

              <div>
                <div style={labelStyle}>Line items</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {items.map((it, idx) => (
                    <div key={it.id} style={{
                      display: 'grid', gridTemplateColumns: '1fr 60px 100px 30px', gap: 8, alignItems: 'center',
                    }}>
                      <input value={it.desc} onChange={e => updateItem(it.id, { desc: e.target.value })}
                        placeholder={idx === 0 ? 'Four-session coaching pack' : 'Description'} style={inputStyle}/>
                      <input type="number" min="0" value={it.qty} onChange={e => updateItem(it.id, { qty: Number(e.target.value) })}
                        placeholder="Qty" style={{ ...inputStyle, textAlign: 'right' }}/>
                      <input type="number" min="0" step="0.01" value={it.rate} onChange={e => updateItem(it.id, { rate: Number(e.target.value) })}
                        placeholder="Rate" style={{ ...inputStyle, textAlign: 'right' }}/>
                      <button onClick={() => removeItem(it.id)} style={{
                        border: 0, background: 'transparent', color: 'var(--muted)',
                        cursor: 'pointer', padding: 4, borderRadius: 6,
                      }}>
                        <Icons.X size={14}/>
                      </button>
                    </div>
                  ))}
                </div>
                <button onClick={addItem} style={{
                  marginTop: 8, border: '1px dashed var(--border-strong)',
                  background: 'transparent', padding: '8px 14px', borderRadius: 8,
                  fontSize: 12.5, fontWeight: 550, color: 'var(--muted)', cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}>
                  <Icons.Plus size={12} sw={2}/> Add line item
                </button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <Field label="Tax rate (%)">
                  <input type="number" min="0" step="0.01" value={taxRate}
                    onChange={e => setTaxRate(Number(e.target.value))} style={inputStyle}/>
                </Field>
                <Field label="Discount ($)">
                  <input type="number" min="0" step="0.01" value={discount}
                    onChange={e => setDiscount(Number(e.target.value))} style={inputStyle}/>
                </Field>
              </div>

              <Field label="Notes to client">
                <textarea value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="Anything you'd like the client to know…"
                  style={{ ...inputStyle, resize: 'vertical', minHeight: 80, fontFamily: 'inherit' }}/>
              </Field>
            </div>
          )}

          {/* Live preview */}
          <div style={{
            padding: preview ? 40 : 28, overflowY: 'auto',
            background: preview ? 'var(--surface-2)' : 'var(--surface)',
          }}>
            <InvoiceRender invoice={invoicePreview} template={template} preview/>
          </div>
        </div>

        <div style={{
          padding: '16px 28px', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            Total · <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg)' }}>{money(invoiceTotal(invoicePreview))}</span>
          </div>
          <div style={{ flex: 1 }}/>
          {!isRecurring && <button className="btn btn-outline" onClick={() => save({ send: false })} disabled={!canSave}>Save draft</button>}
          <button className="btn btn-primary" onClick={() => save({ send: true })} disabled={!canSave}>
            {isRecurring ? <><Icons.Check size={13} sw={2.4}/> Save schedule</> : <><Icons.Send size={13} sw={1.8}/> Send invoice</>}
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle = { fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, display: 'block' };
const inputStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 10,
  border: '1px solid var(--border-strong)', background: 'var(--surface)',
  color: 'var(--fg)', fontSize: 13, outline: 'none', fontFamily: 'inherit',
};
const selectStyle = { ...inputStyle, appearance: 'auto' };

function Field({ label, children }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

/* ============ INVOICE RENDER (the actual doc) ============ */
function InvoiceRender({ invoice, template, preview }) {
  if (!template) return null;
  const sub = invoiceSubtotal(invoice);
  const afterDiscount = sub - (Number(invoice.discount)||0);
  const tax = afterDiscount * ((Number(invoice.taxRate)||0) / 100);
  const total = afterDiscount + tax;

  return (
    <div style={{
      background: template.bg, color: template.text,
      fontFamily: `var(--font-body, 'Inter'), sans-serif`,
      maxWidth: 720, margin: preview ? '0 auto' : 0,
      borderRadius: preview ? 12 : 0,
      boxShadow: preview ? '0 20px 40px rgba(10,12,8,0.12)' : 'none',
      overflow: 'hidden',
    }}>
      {template.header === 'banner' && (
        <div style={{
          height: 10, background: template.accent,
        }}/>
      )}
      <div style={{ padding: '48px 56px 40px' }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 24, marginBottom: 32,
          flexDirection: template.header === 'center' ? 'column' : 'row',
          alignItems: template.header === 'center' ? 'center' : 'flex-start',
          textAlign: template.header === 'center' ? 'center' : 'left',
        }}>
          <div style={{ flex: template.header === 'center' ? 'none' : 1 }}>
            <div style={{
              fontFamily: `var(--font-display, 'Fraunces'), serif`,
              fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em',
              color: template.primary,
            }}>{template.logoText}</div>
            <div style={{ fontSize: 11.5, color: template.muted, marginTop: 4 }}>
              hello@yourbusiness.com · yourbusiness.com
            </div>
          </div>
          <div style={{ textAlign: template.header === 'center' ? 'center' : 'right' }}>
            <div style={{
              fontFamily: `var(--font-display, 'Fraunces'), serif`,
              fontSize: 32, fontWeight: 500, letterSpacing: '-0.02em',
              color: template.primary, lineHeight: 1,
            }}>Invoice</div>
            <div style={{ fontSize: 12, color: template.muted, marginTop: 6, fontFeatureSettings: '"tnum"' }}>
              {invoice.number}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 32 }}>
          <div>
            <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: template.muted, fontWeight: 600, marginBottom: 4 }}>Billed to</div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{invoice.clientName}</div>
            <div style={{ fontSize: 11.5, color: template.muted, marginTop: 2 }}>{invoice.clientEmail}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: template.muted, fontWeight: 600, marginBottom: 4 }}>Issued</div>
            <div style={{ fontSize: 13.5 }}>{fmtDate(invoice.issueDate)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: template.muted, fontWeight: 600, marginBottom: 4 }}>Due</div>
            <div style={{ fontSize: 13.5 }}>{fmtDate(invoice.dueDate)}</div>
          </div>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid color-mix(in srgb, ${template.primary} 20%, transparent)` }}>
              <th style={{ textAlign: 'left', padding: '10px 0', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: template.muted, fontWeight: 600 }}>Description</th>
              <th style={{ textAlign: 'right', padding: '10px 12px', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: template.muted, fontWeight: 600, width: 60 }}>Qty</th>
              <th style={{ textAlign: 'right', padding: '10px 12px', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: template.muted, fontWeight: 600, width: 100 }}>Rate</th>
              <th style={{ textAlign: 'right', padding: '10px 0', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: template.muted, fontWeight: 600, width: 110 }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {(invoice.items||[]).map(it => (
              <tr key={it.id} style={{ borderBottom: `1px solid color-mix(in srgb, ${template.primary} 10%, transparent)` }}>
                <td style={{ padding: '14px 0' }}>{it.desc || <span style={{ color: template.muted, fontStyle: 'italic' }}>-</span>}</td>
                <td style={{ padding: '14px 12px', textAlign: 'right', fontFeatureSettings: '"tnum"' }}>{it.qty}</td>
                <td style={{ padding: '14px 12px', textAlign: 'right', fontFeatureSettings: '"tnum"' }}>{money(it.rate)}</td>
                <td style={{ padding: '14px 0', textAlign: 'right', fontFeatureSettings: '"tnum"', fontWeight: 600 }}>{money((it.qty||0) * (it.rate||0))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <div style={{ width: 280, fontSize: 13 }}>
            <TotalsRow label="Subtotal" value={money(sub)} color={template.muted}/>
            {invoice.discount > 0 && <TotalsRow label="Discount" value={'-' + money(invoice.discount)} color={template.muted}/>}
            {invoice.taxRate > 0 && <TotalsRow label={`Tax (${invoice.taxRate}%)`} value={money(tax)} color={template.muted}/>}
            <div style={{
              display: 'flex', justifyContent: 'space-between', padding: '14px 0 0',
              marginTop: 10, borderTop: `1.5px solid ${template.primary}`,
            }}>
              <span style={{
                fontFamily: `var(--font-display, 'Fraunces'), serif`,
                fontSize: 18, fontWeight: 500, color: template.primary,
              }}>Total due</span>
              <span style={{
                fontFamily: `var(--font-display, 'Fraunces'), serif`,
                fontSize: 22, fontWeight: 600, color: template.primary, fontFeatureSettings: '"tnum"',
              }}>{money(total)}</span>
            </div>
          </div>
        </div>

        {(invoice.notes || template.terms) && (
          <div style={{
            marginTop: 36, padding: '20px 0 0',
            borderTop: `1px solid color-mix(in srgb, ${template.primary} 10%, transparent)`,
            fontSize: 12, color: template.muted, lineHeight: 1.6,
          }}>
            {invoice.notes && <div style={{ marginBottom: template.terms ? 10 : 0 }}>{invoice.notes}</div>}
            {template.terms && <div style={{ fontStyle: 'italic' }}>{template.terms}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
function TotalsRow({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', color }}>
      <span>{label}</span>
      <span style={{ fontFeatureSettings: '"tnum"' }}>{value}</span>
    </div>
  );
}

/* ============ DETAIL DRAWER ============ */
function InvoiceDetailDrawer({ invoiceId, onClose, store, update }) {
  const inv = store.invoices.find(i => i.id === invoiceId);
  const template = store.templates.find(t => t.id === inv?.templateId) || store.templates[0];
  const toast = window.FinanceToast.useToast();
  if (!inv) return null;

  const markPaid = () => {
    const next = {
      ...store,
      invoices: store.invoices.map(i => i.id === inv.id ? {
        ...i, status: 'paid', paidAt: Date.now(), paidMethod: 'manual',
        activity: [...(i.activity||[]), { ts: Date.now(), kind: 'paid', text: `Marked paid · ${money(invoiceTotal(i))}` }],
      } : i),
    };
    update(next);
    toast({ title: 'Marked paid', body: `${inv.number} · ${money(invoiceTotal(inv))}` });
  };
  const sendReminder = () => {
    const next = {
      ...store,
      invoices: store.invoices.map(i => i.id === inv.id ? {
        ...i, activity: [...(i.activity||[]), { ts: Date.now(), kind: 'reminder', text: `Reminder sent to ${i.clientName}` }],
      } : i),
    };
    update(next);
    postInvoiceMessage(inv, { reminder: true });
    toast({ title: 'Reminder sent', body: `Nudged ${inv.clientName}` });
  };
  const deleteInv = () => {
    if (!confirm(`Delete ${inv.number}?`)) return;
    update({ ...store, invoices: store.invoices.filter(i => i.id !== inv.id) });
    onClose();
    toast({ title: 'Invoice deleted', body: inv.number });
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(10,12,8,0.55)', zIndex: 110,
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 900, background: 'var(--surface-2)',
        borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{
          padding: '16px 28px', display: 'flex', alignItems: 'center', gap: 12,
          borderBottom: '1px solid var(--border)', background: 'var(--surface)',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600 }}>{inv.number}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{inv.clientName}</div>
              <InvoiceStatusChip status={inv.status}/>
            </div>
          </div>
          {inv.status !== 'paid' && (
            <>
              <button className="btn btn-outline" onClick={sendReminder}>
                <Icons.Mail size={13} sw={1.8}/> Send reminder
              </button>
              <button className="btn btn-primary" onClick={markPaid}>
                <Icons.Check size={13} sw={2.2}/> Mark paid
              </button>
            </>
          )}
          <button className="btn btn-ghost" onClick={deleteInv} title="Delete" style={{ padding: 8, color: 'var(--muted)' }}>
            <Icons.Trash size={14}/>
          </button>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 8 }}>
            <Icons.X size={15}/>
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', display: 'grid', gridTemplateColumns: '1.4fr 1fr', minHeight: 0 }}>
          <div style={{ padding: 32, overflow: 'auto' }}>
            <InvoiceRender invoice={inv} template={template} preview/>
          </div>
          <div style={{ padding: 24, borderLeft: '1px solid var(--border)', background: 'var(--surface)', overflowY: 'auto' }}>
            <div className="metric-label" style={{ marginBottom: 12 }}>Activity</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {(inv.activity||[]).slice().reverse().map((a, i) => (
                <div key={i} style={{ display: 'flex', gap: 10 }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: 99, flexShrink: 0,
                    background: a.kind === 'paid' ? 'color-mix(in srgb, var(--ok) 18%, var(--surface-2))'
                              : a.kind === 'overdue' ? 'color-mix(in srgb, var(--bad) 18%, var(--surface-2))'
                              : 'var(--surface-2)',
                    color: a.kind === 'paid' ? 'var(--ok)' : a.kind === 'overdue' ? 'var(--bad)' : 'var(--muted)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    marginTop: 2,
                  }}>
                    {a.kind === 'paid' ? <Icons.Check size={11} sw={2.4}/>
                    : a.kind === 'sent' ? <Icons.Send size={11} sw={1.8}/>
                    : a.kind === 'viewed' ? <Icons.Eye size={11} sw={1.8}/>
                    : a.kind === 'reminder' ? <Icons.Mail size={11} sw={1.8}/>
                    : <Icons.Clock size={11} sw={1.8}/>}
                  </div>
                  <div style={{ flex: 1, paddingTop: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 550 }}>{a.text}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>
                      {fmtDate(a.ts)} · {new Date(a.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============ MESSAGES INTEGRATION ============ */
function postInvoiceMessage(inv, opts = {}) {
  try {
    const raw = localStorage.getItem('Ivy OS:messages');
    if (!raw) return;
    const m = JSON.parse(raw);
    const thread = m.threads[inv.clientId] || { mode: m.defaultMode || 'two-way', unreadBiz: 0, unreadClient: 0, messages: [] };
    const text = opts.reminder
      ? `Friendly reminder: invoice ${inv.number} for ${money(invoiceTotal(inv))} is due ${relative(inv.dueDate)}.`
      : `Invoice ${inv.number} · ${money(invoiceTotal(inv))} is ready. Tap below to pay.`;
    thread.messages = [...(thread.messages||[]), {
      from: 'biz', text, ts: Date.now(),
      kind: 'invoice',
      invoice: {
        id: inv.id, number: inv.number, total: invoiceTotal(inv),
        dueDate: inv.dueDate, status: inv.status,
      },
    }];
    thread.unreadClient = (thread.unreadClient || 0) + 1;
    m.threads[inv.clientId] = thread;
    localStorage.setItem('Ivy OS:messages', JSON.stringify(m));
    try { window.dispatchEvent(new StorageEvent('storage', { key: 'Ivy OS:messages' })); } catch {}
  } catch {}
}

/* ============ TEMPLATES TAB ============ */
function TemplatesGallery() {
  const [store, update] = useFinanceStore();
  const [editingId, setEditingId] = React.useState(null);
  const toast = window.FinanceToast.useToast();

  const newTemplate = () => {
    const id = 'tpl-' + Date.now();
    const base = store.templates[0];
    const tpl = { ...base, id, name: 'New template' };
    update({ ...store, templates: [...store.templates, tpl] });
    setEditingId(id);
  };

  if (editingId) {
    const tpl = store.templates.find(t => t.id === editingId);
    return <TemplateEditor template={tpl} onSave={(next) => {
      update({ ...store, templates: store.templates.map(t => t.id === next.id ? next : t) });
      toast({ title: 'Template saved', body: next.name });
      setEditingId(null);
    }} onDelete={() => {
      if (!confirm('Delete this template?')) return;
      update({ ...store, templates: store.templates.filter(t => t.id !== editingId) });
      setEditingId(null);
    }} onClose={() => setEditingId(null)}/>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ padding: 20, display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12, background: 'var(--accent-soft)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Edit size={18} sw={1.6}/>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>Invoice templates</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            Brand your invoices with color, type, and a custom logo. Pick per-invoice when sending.
          </div>
        </div>
        <button className="btn btn-primary" onClick={newTemplate}>
          <Icons.Plus size={13} sw={2}/> New template
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
        {store.templates.map(t => (
          <button key={t.id} className="card" onClick={() => setEditingId(t.id)} style={{
            padding: 0, cursor: 'pointer', overflow: 'hidden', textAlign: 'left',
            border: '1px solid var(--border)', background: 'var(--surface)',
          }}>
            <div style={{
              padding: 16, background: t.bg, height: 180, position: 'relative', overflow: 'hidden',
            }}>
              {t.header === 'banner' && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, background: t.accent }}/>}
              <div style={{
                fontFamily: `'${t.fontDisplay}', serif`, fontSize: 18, fontWeight: 500,
                color: t.primary, letterSpacing: '-0.02em',
                textAlign: t.header === 'center' ? 'center' : 'left',
                marginTop: t.header === 'banner' ? 8 : 0,
              }}>{t.logoText}</div>
              <div style={{
                fontFamily: `'${t.fontDisplay}', serif`, fontSize: 32, fontWeight: 500,
                color: t.primary, letterSpacing: '-0.02em', marginTop: 16,
                textAlign: t.header === 'center' ? 'center' : 'right',
              }}>Invoice</div>
              <div style={{ marginTop: 16, display: 'flex', gap: 6, justifyContent: t.header === 'center' ? 'center' : 'flex-start' }}>
                <div style={{ height: 4, width: 40, background: t.primary, opacity: 0.3, borderRadius: 2 }}/>
                <div style={{ height: 4, width: 60, background: t.primary, opacity: 0.3, borderRadius: 2 }}/>
                <div style={{ height: 4, width: 30, background: t.primary, opacity: 0.3, borderRadius: 2 }}/>
              </div>
              <div style={{
                position: 'absolute', bottom: 16, left: 16, right: 16, height: 2, background: t.accent,
              }}/>
            </div>
            <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{t.name}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{t.fontDisplay} · {t.header}</div>
              </div>
              <div style={{ flex: 1 }}/>
              <div style={{ display: 'flex', gap: 4 }}>
                <span style={{ width: 14, height: 14, borderRadius: 3, background: t.primary, border: '1px solid var(--border)' }}/>
                <span style={{ width: 14, height: 14, borderRadius: 3, background: t.accent, border: '1px solid var(--border)' }}/>
                <span style={{ width: 14, height: 14, borderRadius: 3, background: t.bg, border: '1px solid var(--border)' }}/>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function TemplateEditor({ template, onSave, onDelete, onClose }) {
  const [t, setT] = React.useState(template);
  const set = (patch) => setT({ ...t, ...patch });
  const fonts = [
    { id: 'Fraunces',          cat: 'serif' },
    { id: 'Instrument Serif',  cat: 'serif' },
    { id: 'Playfair Display',  cat: 'serif' },
    { id: 'Inter',             cat: 'sans' },
    { id: 'Plus Jakarta Sans', cat: 'sans' },
    { id: 'Space Grotesk',     cat: 'sans' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 20, alignItems: 'flex-start' }}>
      <div className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18, position: 'sticky', top: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}>
            <Icons.ArrowLeft size={15}/>
          </button>
          <div style={{ flex: 1, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, color: 'var(--muted)' }}>
            Edit template
          </div>
        </div>
        <Field label="Template name">
          <input value={t.name} onChange={e => set({ name: e.target.value })} style={inputStyle}/>
        </Field>
        <Field label="Business name / logo text">
          <input value={t.logoText} onChange={e => set({ logoText: e.target.value })} style={inputStyle}/>
        </Field>
        <div>
          <div style={labelStyle}>Header layout</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {['left','center','banner'].map(h => (
              <button key={h} onClick={() => set({ header: h })} style={{
                flex: 1, padding: '10px 8px', borderRadius: 8, cursor: 'pointer',
                fontSize: 11.5, fontWeight: 550, textTransform: 'capitalize',
                border: '1px solid ' + (t.header === h ? 'var(--accent)' : 'var(--border)'),
                background: t.header === h ? 'var(--accent-soft)' : 'var(--surface)',
                color: t.header === h ? 'var(--accent)' : 'var(--fg-2)',
              }}>{h}</button>
            ))}
          </div>
        </div>
        <div>
          <div style={labelStyle}>Display font</div>
          <select value={t.fontDisplay} onChange={e => set({ fontDisplay: e.target.value })} style={selectStyle}>
            {fonts.map(f => <option key={f.id} value={f.id}>{f.id} ({f.cat})</option>)}
          </select>
        </div>
        <div>
          <div style={labelStyle}>Colors</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[['primary','Primary'],['accent','Accent'],['bg','Background'],['text','Text']].map(([k,label]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted)' }}>
                <input type="color" value={t[k]} onChange={e => set({ [k]: e.target.value })}
                  style={{ width: 30, height: 30, border: 0, borderRadius: 6, cursor: 'pointer', background: 'none' }}/>
                {label}
              </label>
            ))}
          </div>
        </div>
        <Field label="Default terms">
          <textarea value={t.terms} onChange={e => set({ terms: e.target.value })}
            style={{ ...inputStyle, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }}/>
        </Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-outline" onClick={onDelete} style={{ color: 'var(--bad)' }}>
            <Icons.Trash size={13}/> Delete
          </button>
          <div style={{ flex: 1 }}/>
          <button className="btn btn-primary" onClick={() => onSave(t)}>
            <Icons.Check size={13} sw={2.2}/> Save
          </button>
        </div>
      </div>

      <div style={{ padding: 20, background: 'var(--surface-2)', borderRadius: 12, border: '1px solid var(--border)' }}>
        <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600, marginBottom: 14 }}>Live preview</div>
        <InvoiceRender template={t} preview invoice={{
          number: 'INV-1042',
          clientName: 'Ana Beltrán', clientEmail: 'ana@example.com',
          issueDate: Date.now(), dueDate: Date.now() + 14 * 86400e3,
          items: [
            { id: 'p1', desc: 'Four-session coaching pack', qty: 4, rate: 120 },
            { id: 'p2', desc: 'Intake assessment',           qty: 1, rate: 80 },
          ],
          taxRate: 0, discount: 0,
          notes: "Thanks for the commitment - let's do great work together.",
        }}/>
      </div>
    </div>
  );
}

/* ============ RECURRING TAB ============ */
function RecurringList() {
  const [store, update] = useFinanceStore();
  const [creatorOpen, setCreatorOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const toast = window.FinanceToast.useToast();

  const toggleActive = (id) => {
    update({ ...store, recurring: store.recurring.map(r => r.id === id ? { ...r, active: !r.active } : r) });
  };
  const deleteRec = (id) => {
    if (!confirm('Delete this recurring schedule?')) return;
    update({ ...store, recurring: store.recurring.filter(r => r.id !== id) });
    toast({ title: 'Schedule deleted', body: '' });
  };
  const runNow = (id) => {
    const rec = store.recurring.find(r => r.id === id);
    if (!rec) return;
    const inv = {
      id: 'inv-' + Date.now(),
      number: `INV-${store.nextInvoiceNumber}`,
      clientId: rec.clientId, clientName: rec.clientName, clientEmail: rec.clientEmail,
      templateId: rec.templateId, items: rec.items, taxRate: rec.taxRate, discount: rec.discount, notes: rec.notes,
      issueDate: Date.now(), dueDate: Date.now() + 14 * 86400e3,
      status: 'sent', sentAt: Date.now(),
      activity: [{ ts: Date.now(), kind: 'sent', text: `Auto-generated from recurring schedule · sent to ${rec.clientName}` }],
    };
    update({
      ...store,
      invoices: [inv, ...store.invoices],
      nextInvoiceNumber: store.nextInvoiceNumber + 1,
      recurring: store.recurring.map(r => r.id === id ? { ...r, lastRun: Date.now(), nextRun: nextRunDate(r.frequency) } : r),
    });
    postInvoiceMessage(inv);
    toast({ title: 'Invoice generated', body: `${inv.number} → ${rec.clientName}` });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ padding: 20, display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12, background: 'var(--accent-soft)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icons.Repeat size={18} sw={1.6}/>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>Recurring invoices</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            Set it once. Ivy OS auto-generates and sends invoices on schedule.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => { setEditing(null); setCreatorOpen(true); }}>
          <Icons.Plus size={13} sw={2}/> New schedule
        </button>
      </div>

      {store.recurring.length === 0 ? (
        <div className="card" style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}>
          <Icons.Repeat size={36} sw={1.3}/>
          <div style={{ fontSize: 14, fontWeight: 550, marginTop: 12, color: 'var(--fg-2)' }}>No recurring invoices yet</div>
          <div style={{ fontSize: 12.5, marginTop: 4 }}>Perfect for retainers, memberships, or monthly programs.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
          {store.recurring.map(r => (
            <div key={r.id} className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{r.clientName}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{r.clientEmail}</div>
                </div>
                <button onClick={() => toggleActive(r.id)} style={{
                  width: 36, height: 20, borderRadius: 99, padding: 0, border: 0, cursor: 'pointer',
                  background: r.active ? 'var(--accent)' : 'var(--border-strong)',
                  position: 'relative', transition: 'background .15s',
                }} title={r.active ? 'Active' : 'Paused'}>
                  <span style={{
                    position: 'absolute', top: 2, left: r.active ? 18 : 2,
                    width: 16, height: 16, borderRadius: 99, background: '#fff',
                    transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }}/>
                </button>
              </div>
              <div style={{
                padding: 14, borderRadius: 10, background: 'var(--surface-2)',
                border: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>
                  Amount per run
                </div>
                <div style={{
                  fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 500,
                  marginTop: 2, letterSpacing: '-0.02em',
                }}>{money(invoiceTotal(r))}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                  {r.items[0]?.desc}{r.items.length > 1 ? ` +${r.items.length-1} more` : ''}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>Frequency</div>
                  <div style={{ fontSize: 12.5, fontWeight: 550, marginTop: 2, textTransform: 'capitalize' }}>{r.frequency}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>Next run</div>
                  <div style={{
                    fontSize: 12.5, fontWeight: 550, marginTop: 2,
                    color: r.active ? 'var(--accent)' : 'var(--muted)',
                  }}>
                    {r.active ? (fmtDateShort(r.nextRun) + ' · ' + relative(r.nextRun)) : 'Paused'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }} onClick={() => { setEditing(r); setCreatorOpen(true); }}>
                  Edit
                </button>
                <button className="btn btn-outline" style={{ flex: 1, justifyContent: 'center' }} onClick={() => runNow(r.id)}>
                  <Icons.Send size={12} sw={1.8}/> Run now
                </button>
                <button className="btn btn-ghost" onClick={() => deleteRec(r.id)} style={{ padding: 8, color: 'var(--muted)' }} title="Delete">
                  <Icons.Trash size={13}/>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {creatorOpen && (
        <InvoiceCreator
          onClose={() => { setCreatorOpen(false); setEditing(null); }}
          store={store} update={update} editing={editing} isRecurring
          onSaveRecurring={(rec) => {
            const [s, u] = [store, update];
            u({ ...s, recurring: editing
              ? s.recurring.map(r => r.id === rec.id ? rec : r)
              : [...s.recurring, rec] });
            toast({ title: 'Schedule saved', body: `${rec.clientName} · ${rec.frequency}` });
            setCreatorOpen(false); setEditing(null);
          }}/>
      )}
    </div>
  );
}

function nextRunDate(freq) {
  const D = 86400e3;
  switch (freq) {
    case 'weekly':    return Date.now() + 7 * D;
    case 'biweekly':  return Date.now() + 14 * D;
    case 'monthly':   return Date.now() + 30 * D;
    case 'quarterly': return Date.now() + 91 * D;
    case 'yearly':    return Date.now() + 365 * D;
    default:          return Date.now() + 30 * D;
  }
}

/* ============ EXPORT ============ */
window.InvoicesModule = {
  List: InvoicesList,
  Templates: TemplatesGallery,
  Recurring: RecurringList,
  InvoiceRender,
  postInvoiceMessage,
};
// expose toast for cross-component access (since finance.jsx defines it)
window.FinanceToast = window.FinanceToast || {};
