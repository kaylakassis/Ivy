// Rewards: landing pitch (before launch) + program manager (after).
import React, { useState, useMemo, useEffect } from 'react';
import { Icons } from '../../components/Icons.jsx';
import EmptyNote from '../../components/EmptyNote.jsx';
import { useRewards } from './state.js';
import { api } from '../../lib/api.js';

const RULE_TYPE_LABELS = {
  visit:    'Visit-based',
  spend:    'Spend-based',
  referral: 'Referral',
  custom:   'Custom',
};

export default function Rewards() {
  const r = useRewards();
  if (r.loading) return <div style={{ padding: 48, color: 'var(--muted)', fontSize: 13 }}>Loading rewards…</div>;
  if (r.error)   return (
    <div style={{ padding: 48 }}>
      <div className="card" style={{ padding: 40 }}>
        <EmptyNote icon="Gift" title="Couldn't load rewards" hint={r.error.message || 'Try refreshing.'}/>
      </div>
    </div>
  );

  return r.settings.launched
    ? <RewardsManager r={r}/>
    : <RewardsLanding onLaunch={() => r.setLaunched(true)}/>;
}

// ---------- LANDING ----------
function RewardsLanding({ onLaunch }) {
  const stats = [
    { value: '67%',    body: 'Repeat customers spend 67% more than new customers.', src: 'Bain & Company',  tone: 'ok',     icon: <Icons.Trending size={18} sw={1.8}/> },
    { value: '60–70%', body: 'Probability of selling to an existing customer vs. 5–20% for new ones.', src: 'Invesp', tone: 'accent', icon: <Icons.Users    size={18} sw={1.8}/> },
    { value: '2.5×',   body: 'Businesses with loyalty programs grow revenue 2.5× faster.', src: 'Annex Cloud', tone: 'warn',   icon: <Icons.Heart    size={18} sw={1.8}/> },
  ];
  const offerings = [
    { title: 'Visit-based rewards', body: 'Book 5, get 1 free.' },
    { title: 'Spend-based rewards', body: 'Spend $300, get $25 credit.' },
    { title: 'Referral bonuses',    body: 'Refer a friend — both get rewarded.' },
    { title: 'Custom rules',        body: 'Design your own loyalty program.' },
  ];

  return (
    <div style={{ padding: '48px 32px 80px', maxWidth: 820, margin: '0 auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, marginBottom: 36 }}>
        <div style={{
          width: 72, height: 72, borderRadius: 999,
          background: 'var(--accent)', color: 'var(--accent-ink)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><Icons.Gift size={34} sw={1.8}/></div>
        <div style={{ textAlign: 'center' }}>
          <h1 className="page-title" style={{ margin: 0, fontSize: 38 }}>Welcome to Client Rewards</h1>
          <p style={{ fontSize: 16, color: 'var(--muted)', margin: '10px 0 0' }}>
            Turn one-time visitors into loyal, repeat customers.
          </p>
        </div>
      </div>

      <div className="card" style={{ padding: 24, marginBottom: 18 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Why reward programs work</h3>
        <p style={{ margin: '6px 0 18px', fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
          Loyalty isn't about giveaways — it's about making your best clients feel seen. The data agrees:
        </p>
        <div className="grid-auto-sm">
          {stats.map((s, i) => <StatTile key={i} {...s}/>)}
        </div>
      </div>

      <div className="card" style={{ padding: 24, marginBottom: 24 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 600 }}>What you can do</h3>
        <div className="split-2">
          {offerings.map((o, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <div style={{
                width: 22, height: 22, borderRadius: 99,
                background: 'var(--accent-soft)', color: 'var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1,
              }}>
                <Icons.Check size={12} sw={2.4}/>
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{o.title}</div>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{o.body}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <button className="btn btn-primary" onClick={onLaunch} style={{ padding: '14px 26px', fontSize: 15, gap: 10 }}>
          Set up my first reward program <Icons.Arrow size={15} sw={2}/>
        </button>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Takes less than 2 minutes</div>
      </div>
    </div>
  );
}

function StatTile({ value, body, src, tone, icon }) {
  const fg = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : 'var(--accent)';
  return (
    <div style={{
      padding: 18, borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'center', alignItems: 'center',
    }}>
      <div style={{ color: fg }}>{icon}</div>
      <div className="metric-value" style={{ fontSize: 30, color: fg }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--fg-2)', lineHeight: 1.45 }}>{body}</div>
      <div style={{ fontSize: 10, color: 'var(--muted-2)' }}>— {src}</div>
    </div>
  );
}

// ---------- MANAGER ----------
function RewardsManager({ r }) {
  const [tab, setTab]                 = useState('rules');
  const [editingRule, setEditingRule] = useState(null);
  const [logOpen, setLogOpen]         = useState(false);
  const [confirmTarget, setConfirmTarget] = useState(null);

  const pending = r.pending || [];

  return (
    <div className="page-pad" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="metric-label" style={{ color: 'var(--accent)' }}>Program live</div>
          <h2 className="page-title" style={{ margin: 0, fontSize: 32 }}>Client rewards</h2>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>
            Tune your rules, track redemptions, watch repeat revenue grow.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" onClick={() => setLogOpen(true)}>
            <Icons.Plus size={13}/> Log redemption
          </button>
          <button className="btn btn-primary" onClick={() => setEditingRule({ /* new */ })}>
            <Icons.Plus size={13} sw={2}/> New rule
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid-auto">
        <Kpi label="Active members"      value={r.kpis.activeMembers} sub="Clients with at least one redemption"/>
        <Kpi label="Rewards redeemed"    value={r.kpis.rewardsRedeemed} sub="All time"/>
        <Kpi label="Repeat revenue"      value={fmtMoney(r.kpis.repeatRevenue)} sub="From clients with 2+ paid invoices" tone="accent"/>
        <Kpi label="Referrals converted" value={r.kpis.referralsConverted} sub="Redemptions of referral rules" tone="ok"/>
      </div>

      {/* Ready to redeem — auto-detected eligibility */}
      {pending.length > 0 && (
        <div className="card glow-ready-soft" style={{ overflow: 'hidden', borderColor: 'var(--ok)' }}>
          <div style={{
            padding: '14px 20px', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'color-mix(in srgb, var(--ok) 8%, transparent)',
          }}>
            <Icons.Gift size={16} sw={1.8} stroke="var(--ok)"/>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ok)' }}>
                {pending.length} reward{pending.length === 1 ? '' : 's'} ready to issue
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                Auto-detected from real visits, spend, and referrals. Confirm to notify the client.
              </div>
            </div>
          </div>
          {pending.map((p, i) => (
            <PendingRow key={`${p.rule.id}:${p.clientId}`} entry={p} first={i === 0}
              onConfirm={() => setConfirmTarget(p)}
              onDismiss={async () => {
                if (confirm(`Dismiss this reward for ${p.clientName}? They won't be notified, and the same milestone won't fire again.`)) {
                  try { await r.dismissPending({ ruleId: p.rule.id, clientId: p.clientId }); }
                  catch (e) { alert('Could not dismiss: ' + (e.message || 'unknown error')); }
                }
              }}/>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="tab-row">
        {[
          { id: 'rules', label: 'Rules', count: r.rules.length },
          { id: 'redemptions', label: 'Redemptions', count: r.redemptions.length },
        ].map(({ id, label, count }) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: '6px 14px', borderRadius: 8, border: 0, fontSize: 12.5, fontWeight: 550, cursor: 'pointer',
            background: tab === id ? 'var(--surface)' : 'transparent',
            color: tab === id ? 'var(--fg)' : 'var(--muted)',
            boxShadow: tab === id ? 'var(--shadow-sm)' : 'none',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            {label}
            <span style={{
              fontSize: 10.5, padding: '1px 6px', borderRadius: 99,
              background: tab === id ? 'var(--surface-2)' : 'var(--surface)',
              color: 'var(--muted)', fontWeight: 600,
            }}>{count}</span>
          </button>
        ))}
      </div>

      {tab === 'rules' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          {r.rules.length === 0 ? (
            <div style={{ padding: 48 }}>
              <EmptyNote icon="Gift" title="No rules yet" hint="Click New rule to add your first."/>
            </div>
          ) : r.rules.map((rule, i) => (
            <RuleRow key={rule.id} rule={rule} first={i === 0}
              onToggle={(active) => r.updateRule(rule.id, { active })}
              onEdit={() => setEditingRule(rule)}
              onDelete={() => r.removeRule(rule.id)}/>
          ))}
        </div>
      )}

      {tab === 'redemptions' && (
        <div className="card" style={{ overflow: 'hidden' }}>
          {r.redemptions.length === 0 ? (
            <div style={{ padding: 48 }}>
              <EmptyNote icon="Heart" title="No redemptions yet" hint="Log one when you give a client a reward."/>
            </div>
          ) : r.redemptions.map((red, i) => (
            <RedemptionRow key={red.id} redemption={red} rule={r.rules.find((x) => x.id === red.ruleId)} first={i === 0}
              onDelete={() => r.removeRedemption(red.id)}
              onMarkUsed={() => r.markRedemptionStatus(red.id, 'used')}
              onUnmark={() => r.markRedemptionStatus(red.id, 'issued')}/>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn btn-ghost" style={{ fontSize: 11.5, color: 'var(--muted)' }}
          onClick={() => { if (confirm('Pause the rewards program? Rules and redemptions are kept.')) r.setLaunched(false); }}>
          Pause program
        </button>
      </div>

      {editingRule && (
        <RuleEditor
          rule={editingRule}
          onClose={() => setEditingRule(null)}
          onSave={async (patch) => {
            if (editingRule.id) await r.updateRule(editingRule.id, patch);
            else await r.createRule(patch);
            setEditingRule(null);
          }}
        />
      )}
      {logOpen && (
        <LogRedemptionModal
          rules={r.rules.filter((x) => x.active)}
          onSubmit={async (input) => { await r.logRedemption(input); setLogOpen(false); }}
          onClose={() => setLogOpen(false)}
        />
      )}
      {confirmTarget && (
        <ConfirmRewardModal
          entry={confirmTarget}
          onClose={() => setConfirmTarget(null)}
          onSubmit={async ({ validityDays, sendMessage }) => {
            await r.confirmPending({
              ruleId: confirmTarget.rule.id,
              clientId: confirmTarget.clientId,
              validityDays, sendMessage,
            });
            setConfirmTarget(null);
          }}
        />
      )}
    </div>
  );
}

function PendingRow({ entry, first, onConfirm, onDismiss }) {
  const { rule, clientName, current, threshold, pending } = entry;
  const isMoney = rule.type === 'spend';
  const fmt = (n) => isMoney
    ? '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
    : Number(n || 0).toLocaleString();
  const triggerNote = rule.type === 'visit'    ? 'completed visits'
                    : rule.type === 'spend'    ? 'in paid invoices'
                    : rule.type === 'referral' ? 'referrals brought in'
                    : 'units';
  return (
    <div style={{
      padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 14,
      borderTop: first ? 'none' : '1px solid var(--border)',
      flexWrap: 'wrap',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10, flexShrink: 0,
        background: 'var(--ok)', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Gift size={16} sw={1.8}/></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>
          {clientName || 'Client'} · {rule.name}
          {pending > 1 && (
            <span style={{
              marginLeft: 8, fontSize: 10.5, padding: '1px 7px', borderRadius: 99,
              background: 'var(--ok)', color: '#fff', fontWeight: 700,
            }}>{pending}× pending</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
          {fmt(current)} {triggerNote} · threshold {fmt(threshold)}
          {rule.rewardText && <> → <strong style={{ color: 'var(--fg-2)' }}>{rule.rewardText}</strong></>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
        <button className="btn btn-ghost" onClick={onDismiss}
          style={{ padding: '6px 10px', fontSize: 12, color: 'var(--muted)' }}>
          Dismiss
        </button>
        <button className="btn btn-primary" onClick={onConfirm} style={{ padding: '6px 12px', fontSize: 12.5 }}>
          Confirm <Icons.Arrow size={11} sw={2.4}/>
        </button>
      </div>
    </div>
  );
}

function ConfirmRewardModal({ entry, onClose, onSubmit }) {
  const [validityDays, setValidityDays] = useState(30);
  const [sendMessage, setSendMessage]   = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await onSubmit({ validityDays: Number(validityDays), sendMessage }); }
    catch (ex) { setErr(ex.message || 'Could not confirm'); setBusy(false); }
  };

  const expiry = new Date(Date.now() + Number(validityDays || 0) * 86400 * 1000);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="card" style={{ padding: 24, width: '100%', maxWidth: 460 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10, background: 'var(--ok)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Gift size={16} sw={1.8}/></div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, flex: 1 }}>Confirm reward</h3>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}><Icons.X size={15}/></button>
        </div>

        <div style={{
          padding: 12, borderRadius: 10, background: 'var(--surface-2)',
          border: '1px solid var(--border)', marginBottom: 16, fontSize: 13, lineHeight: 1.55,
        }}>
          <div style={{ fontWeight: 600 }}>{entry.clientName}</div>
          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 2 }}>
            Earned via <strong style={{ color: 'var(--fg-2)' }}>{entry.rule.name}</strong>
          </div>
          {entry.rule.rewardText && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              Reward: <strong>{entry.rule.rewardText}</strong>
            </div>
          )}
        </div>

        <Field label="Valid for" hint={`Reward will expire ${expiry.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}.`}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="number" min={1} max={365} value={validityDays}
              onChange={(e) => setValidityDays(e.target.value)} style={{ ...inputS, width: 100 }}/>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>days</span>
          </div>
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--fg-2)', marginBottom: 14 }}>
          <input type="checkbox" checked={sendMessage} onChange={(e) => setSendMessage(e.target.checked)}/>
          Notify {entry.clientName} via in-app message
        </label>

        {err && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 12 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn btn-outline" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy} style={{ flex: 2, justifyContent: 'center' }}>
            {busy ? 'Confirming…' : 'Issue reward'}
          </button>
        </div>
      </form>
    </div>
  );
}

function RuleRow({ rule, first, onToggle, onEdit, onDelete }) {
  return (
    <div style={{
      padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 16,
      borderTop: first ? 'none' : '1px solid var(--border)',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10, flexShrink: 0,
        background: rule.active ? 'var(--accent-soft)' : 'var(--surface-2)',
        color: rule.active ? 'var(--accent)' : 'var(--muted)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Gift size={16} sw={1.7}/></div>
      <div style={{ flex: 1, minWidth: 0, opacity: rule.active ? 1 : 0.55 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{rule.name}</span>
          <span style={{
            fontSize: 10, padding: '1px 7px', borderRadius: 99,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em',
          }}>{RULE_TYPE_LABELS[rule.type]}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
          {rule.triggerText || '—'} → <strong style={{ color: 'var(--fg-2)' }}>{rule.rewardText || '—'}</strong>
        </div>
      </div>
      {/* Active toggle */}
      <button onClick={() => onToggle(!rule.active)} style={{
        width: 38, height: 22, borderRadius: 99, flexShrink: 0,
        background: rule.active ? 'var(--accent)' : 'var(--surface-2)',
        border: `1px solid ${rule.active ? 'var(--accent)' : 'var(--border-strong)'}`,
        position: 'relative', cursor: 'pointer',
      }} title={rule.active ? 'Pause rule' : 'Activate rule'}>
        <span style={{
          position: 'absolute', top: 2, left: rule.active ? 18 : 2,
          width: 16, height: 16, borderRadius: 99,
          background: rule.active ? 'var(--accent-ink)' : '#fff',
          transition: 'left .12s',
        }}/>
      </button>
      <button className="btn btn-ghost" onClick={onEdit} style={{ padding: 6 }} title="Edit"><Icons.Edit size={13}/></button>
      <button className="btn btn-ghost" onClick={() => { if (confirm('Delete rule?')) onDelete(); }}
        style={{ padding: 6, color: 'var(--danger)' }}><Icons.Trash size={13}/></button>
    </div>
  );
}

function RedemptionRow({ redemption, rule, first, onDelete, onMarkUsed, onUnmark }) {
  const status = redemption.status || 'used';
  const expiresAt = redemption.expiresAt ? new Date(redemption.expiresAt) : null;
  const isExpired = expiresAt && expiresAt.getTime() < Date.now() && status === 'issued';
  const tone = status === 'used'      ? { bg: 'var(--surface-2)', fg: 'var(--muted)',  label: 'Used' }
             : status === 'dismissed' ? { bg: 'var(--surface-2)', fg: 'var(--muted)',  label: 'Dismissed' }
             : isExpired              ? { bg: 'color-mix(in srgb, var(--danger) 12%, transparent)', fg: 'var(--danger)', label: 'Expired' }
                                      : { bg: 'color-mix(in srgb, var(--ok) 14%, transparent)',    fg: 'var(--ok)',     label: 'Issued' };

  const expiryLabel = !expiresAt ? null
    : status !== 'issued' ? null
    : isExpired ? 'Expired'
    : 'Valid until ' + expiresAt.toLocaleDateString([], { month: 'short', day: 'numeric' });

  return (
    <div style={{
      padding: '14px 20px', display: 'flex', alignItems: 'center', gap: 16,
      borderTop: first ? 'none' : '1px solid var(--border)',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10, flexShrink: 0,
        background: status === 'issued' && !isExpired ? 'var(--ok)' : 'var(--surface-2)',
        color: status === 'issued' && !isExpired ? '#fff' : 'var(--muted)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><Icons.Heart size={15} sw={1.7}/></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{redemption.clientName || 'Client'}</span>
          <span style={{
            fontSize: 10, padding: '1px 7px', borderRadius: 99,
            background: tone.bg, color: tone.fg,
            fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
          }}>{tone.label}</span>
          {redemption.autoDetected && status !== 'dismissed' && (
            <span style={{
              fontSize: 9.5, padding: '1px 6px', borderRadius: 99,
              background: 'var(--accent-soft)', color: 'var(--accent)',
              fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>auto</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
          {redemption.rewardText || rule?.rewardText || rule?.name || '—'}
          {expiryLabel && <> · <span style={{ color: isExpired ? 'var(--danger)' : 'var(--muted)' }}>{expiryLabel}</span></>}
          {redemption.notes && <> · {redemption.notes}</>}
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
        {new Date(redemption.redeemedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
      </div>
      {status === 'issued' && onMarkUsed && (
        <button className="btn btn-outline" onClick={onMarkUsed}
          style={{ padding: '4px 10px', fontSize: 11.5 }} title="Mark this reward as cashed in">
          <Icons.Check size={12} sw={2.4}/> Mark used
        </button>
      )}
      {status === 'used' && onUnmark && (
        <button className="btn btn-ghost" onClick={onUnmark}
          style={{ padding: '4px 8px', fontSize: 11.5, color: 'var(--muted)' }} title="Undo">
          Undo
        </button>
      )}
      <button className="btn btn-ghost" onClick={() => { if (confirm('Remove this redemption record?')) onDelete(); }}
        style={{ padding: 6, color: 'var(--muted)' }}><Icons.X size={13}/></button>
    </div>
  );
}

function RuleEditor({ rule, onClose, onSave }) {
  const [name, setName]     = useState(rule.name || '');
  const [type, setType]     = useState(rule.type || 'visit');
  const [triggerText, setTriggerText] = useState(rule.triggerText || '');
  const [rewardText, setRewardText]   = useState(rule.rewardText  || '');
  const [threshold, setThreshold]     = useState(rule.threshold ?? 0);
  const [active, setActive]           = useState(rule.active !== false);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Name is required'); return; }
    setBusy(true); setErr(null);
    try { await onSave({ name: name.trim(), type, triggerText, rewardText, threshold: Number(threshold), active }); }
    catch (ex) { setErr(ex.message || 'Could not save'); setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="card" style={{ padding: 24, width: '100%', maxWidth: 480 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 10, background: 'var(--accent-soft)', color: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icons.Gift size={16} sw={1.8}/></div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, flex: 1 }}>{rule.id ? 'Edit rule' : 'New rule'}</h3>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}><Icons.X size={15}/></button>
        </div>

        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus style={inputS}/>
        </Field>
        <Field label="Type">
          <select value={type} onChange={(e) => setType(e.target.value)} style={inputS}>
            <option value="visit">Visit-based (count of bookings)</option>
            <option value="spend">Spend-based (cumulative paid)</option>
            <option value="referral">Referral</option>
            <option value="custom">Custom</option>
          </select>
        </Field>
        <Field label="Trigger" hint="When the reward kicks in. e.g. After 5 booked services">
          <input value={triggerText} onChange={(e) => setTriggerText(e.target.value)} style={inputS}/>
        </Field>
        <Field label="Reward" hint="What the client gets. e.g. 1 free session, $25 credit">
          <input value={rewardText} onChange={(e) => setRewardText(e.target.value)} style={inputS}/>
        </Field>
        <Field label="Threshold" hint="Numeric trigger value (visits or $)">
          <input type="number" min={0} value={threshold} onChange={(e) => setThreshold(e.target.value)} style={inputS}/>
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--fg-2)', marginBottom: 14 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)}/>
          Active (clients can earn this reward)
        </label>

        {err && (
          <div style={{
            padding: '8px 12px', borderRadius: 8, marginBottom: 14,
            background: 'rgba(155,44,44,0.08)', border: '1px solid rgba(155,44,44,0.25)',
            color: 'var(--danger)', fontSize: 12.5,
          }}>{err}</div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn btn-outline" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy} style={{ flex: 2, justifyContent: 'center' }}>
            {busy ? 'Saving…' : (rule.id ? 'Save changes' : 'Add rule')}
          </button>
        </div>
      </form>
    </div>
  );
}

function LogRedemptionModal({ rules, onSubmit, onClose }) {
  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState('');
  const [ruleId, setRuleId]     = useState('');
  const [rewardText, setRewardText] = useState('');
  const [notes, setNotes]       = useState('');
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState(null);

  useEffect(() => {
    api.get('/clients').then((r) => setClients(r.clients || [])).catch(() => {});
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!clientId) { setErr('Pick a client'); return; }
    setBusy(true); setErr(null);
    try {
      const rule = rules.find((r) => r.id === ruleId);
      await onSubmit({
        clientId,
        ruleId: ruleId || null,
        rewardText: rewardText.trim() || rule?.rewardText || rule?.name || null,
        notes: notes.trim() || null,
      });
    } catch (ex) { setErr(ex.message || 'Could not log'); setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 130,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="card" style={{ padding: 24, width: '100%', maxWidth: 480 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, flex: 1 }}>Log a redemption</h3>
          <button type="button" className="btn btn-ghost" onClick={onClose} style={{ padding: 6 }}><Icons.X size={15}/></button>
        </div>

        <Field label="Client">
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} style={inputS} required>
            <option value="">— Pick a client —</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.email ? ` · ${c.email}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Rule (optional)">
          <select value={ruleId} onChange={(e) => setRuleId(e.target.value)} style={inputS}>
            <option value="">— Free-form (no rule) —</option>
            {rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <Field label="Reward given" hint="What you handed them. Defaults to the rule's reward if a rule is selected.">
          <input value={rewardText} onChange={(e) => setRewardText(e.target.value)} placeholder="e.g. 1 free session" style={inputS}/>
        </Field>
        <Field label="Notes (optional)">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            style={{ ...inputS, fontFamily: 'inherit', resize: 'vertical' }}/>
        </Field>

        {err && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 12 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn btn-outline" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy} style={{ flex: 2, justifyContent: 'center' }}>
            {busy ? 'Saving…' : 'Log redemption'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Kpi({ label, value, sub, tone = 'neutral' }) {
  const colors = { ok: 'var(--ok)', warn: 'var(--warn)', accent: 'var(--accent)', neutral: 'var(--fg)' };
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ fontSize: 28, color: colors[tone] || colors.neutral }}>{value}</div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{sub}</div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 500 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

const inputS = {
  width: '100%', padding: '8px 12px', borderRadius: 8,
  background: 'var(--surface)', border: '1px solid var(--border-strong)',
  color: 'var(--fg)', fontSize: 13, outline: 'none', fontFamily: 'inherit',
};
