// Shared serializers + helpers for the rewards feature.
import { sql } from './db.js';

export const VALID_RULE_TYPES = new Set(['visit', 'spend', 'referral', 'custom']);
export const VALID_REDEMPTION_STATUSES = new Set(['issued', 'used', 'dismissed']);
// How many days a reward stays valid once issued. Owners can override per-confirm.
export const DEFAULT_VALIDITY_DAYS = 30;

export function serializeRule(row) {
  if (!row) return null;
  return {
    id:           row.id,
    type:         row.type,
    name:         row.name,
    triggerText:  row.trigger_text,
    rewardText:   row.reward_text,
    threshold:    Number(row.threshold || 0),
    active:       row.active,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
  };
}

export function serializeRedemption(row) {
  if (!row) return null;
  return {
    id:            row.id,
    ruleId:        row.rule_id,
    clientId:      row.client_id,
    clientName:    row.client_name,
    rewardText:    row.reward_text,
    notes:         row.notes,
    redeemedAt:    row.redeemed_at,
    status:        row.status || 'used',
    expiresAt:     row.expires_at,
    usedAt:        row.used_at,
    notifiedAt:    row.notified_at,
    autoDetected:  !!row.auto_detected,
  };
}

export async function ensureRewardSettings(workspaceId) {
  const r = await sql`
    INSERT INTO reward_settings (workspace_id) VALUES (${workspaceId})
    ON CONFLICT (workspace_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
    RETURNING *
  `;
  return r.rows[0];
}

// KPIs for the rewards manager dashboard.
export async function rewardKpis(workspaceId) {
  // Active members = unique clients who have redeemed something at least once.
  // Rewards redeemed = total redemptions.
  // Revenue from repeats = sum of paid invoices for clients who paid more than once.
  // Referrals converted = redemptions of rules with type='referral'.
  const { rows } = await sql`
    WITH redemptions AS (
      SELECT * FROM reward_redemptions WHERE workspace_id = ${workspaceId}
    ),
    repeats AS (
      SELECT i.client_id
      FROM invoices i
      WHERE i.workspace_id = ${workspaceId}
        AND i.status = 'paid'
        AND i.client_id IS NOT NULL
      GROUP BY i.client_id
      HAVING COUNT(*) >= 2
    ),
    repeat_revenue AS (
      SELECT COALESCE(SUM(
        GREATEST(
          (SELECT COALESCE(SUM((it->>'quantity')::numeric * (it->>'rate')::numeric), 0)
            FROM jsonb_array_elements(items) AS it) - discount,
          0
        ) * (1 + tax_rate / 100)
      ), 0)::numeric AS amount
      FROM invoices
      WHERE workspace_id = ${workspaceId}
        AND status = 'paid'
        AND client_id IN (SELECT client_id FROM repeats)
    )
    SELECT
      (SELECT COUNT(DISTINCT client_id) FROM redemptions WHERE client_id IS NOT NULL) AS active_members,
      (SELECT COUNT(*)                  FROM redemptions)                              AS total_redeemed,
      (SELECT COUNT(*)                  FROM redemptions r
         JOIN reward_rules ru ON ru.id = r.rule_id WHERE ru.type = 'referral')         AS referrals_converted,
      (SELECT amount                    FROM repeat_revenue)                            AS repeat_revenue
  `;
  const r = rows[0] || {};
  return {
    activeMembers:       Number(r.active_members || 0),
    rewardsRedeemed:     Number(r.total_redeemed || 0),
    referralsConverted:  Number(r.referrals_converted || 0),
    repeatRevenue:       Number(r.repeat_revenue || 0),
  };
}

// ============================================================================
// AUTO ELIGIBILITY
// ============================================================================
// For each non-custom active rule, compute every client's progress against
// that rule from real workspace data:
//   visit    → count of completed (non-cancelled, on/before today) bookings
//   spend    → sum of paid invoice totals (incl. tax, less discount)
//   referral → count of clients whose referred_by_client_id points at them
//
// A reward is "earned" once `current >= threshold`. Each crossing of a multiple
// of the threshold (10, 20, 30…) is one earned reward. The number actually
// claimed is `count(reward_redemptions WHERE rule_id = X AND client_id = Y)`
// - including 'dismissed' rows so the same milestone never re-fires.
// pending = max(0, earnedCount - claimedCount).

function progressQueryForType(type) {
  if (type === 'visit') {
    return `
      SELECT c.id AS client_id, c.name, c.email,
             COUNT(b.id) FILTER (
               WHERE b.cancelled_at IS NULL AND b.date <= CURRENT_DATE
             )::numeric AS current
      FROM clients c
      LEFT JOIN bookings b
        ON b.client_id = c.id AND b.workspace_id = c.workspace_id
      WHERE c.workspace_id = $1
      GROUP BY c.id
    `;
  }
  if (type === 'spend') {
    return `
      SELECT c.id AS client_id, c.name, c.email,
             COALESCE(SUM(
               GREATEST(
                 (SELECT COALESCE(SUM((it->>'quantity')::numeric * (it->>'rate')::numeric), 0)
                  FROM jsonb_array_elements(i.items) AS it) - i.discount,
                 0
               ) * (1 + i.tax_rate / 100)
             ) FILTER (WHERE i.status = 'paid'), 0)::numeric AS current
      FROM clients c
      LEFT JOIN invoices i
        ON i.client_id = c.id AND i.workspace_id = c.workspace_id
      WHERE c.workspace_id = $1
      GROUP BY c.id
    `;
  }
  if (type === 'referral') {
    return `
      SELECT c.id AS client_id, c.name, c.email,
             COUNT(ref.id)::numeric AS current
      FROM clients c
      LEFT JOIN clients ref
        ON ref.referred_by_client_id = c.id AND ref.workspace_id = c.workspace_id
      WHERE c.workspace_id = $1
      GROUP BY c.id
    `;
  }
  return null;
}

export async function clientProgressForRule(workspaceId, rule) {
  const q = progressQueryForType(rule.type);
  if (!q) return [];
  const { rows } = await sql.query(q, [workspaceId]);
  return rows.map((r) => ({
    clientId: r.client_id,
    clientName: r.name,
    clientEmail: r.email,
    current: Number(r.current || 0),
  }));
}

// Aggregated pending detection across every active non-custom rule.
// Returns: [{ rule, clientId, clientName, clientEmail, current, threshold,
//             earned, claimed, pending }]
export async function pendingRewards(workspaceId) {
  const rules = await sql`
    SELECT * FROM reward_rules
    WHERE workspace_id = ${workspaceId} AND active = TRUE AND type <> 'custom'
    ORDER BY created_at ASC
  `;

  if (rules.rows.length === 0) return [];

  const claims = await sql`
    SELECT rule_id, client_id, COUNT(*)::int AS n
    FROM reward_redemptions
    WHERE workspace_id = ${workspaceId} AND rule_id IS NOT NULL AND client_id IS NOT NULL
    GROUP BY rule_id, client_id
  `;
  const claimMap = new Map();
  for (const c of claims.rows) claimMap.set(`${c.rule_id}:${c.client_id}`, Number(c.n));

  const out = [];
  for (const r of rules.rows) {
    const threshold = Number(r.threshold || 0);
    if (threshold <= 0) continue; // misconfigured - skip
    const progress = await clientProgressForRule(workspaceId, r);
    for (const p of progress) {
      const earned = Math.floor(p.current / threshold);
      if (earned <= 0) continue;
      const claimed = claimMap.get(`${r.id}:${p.clientId}`) || 0;
      const pending = Math.max(0, earned - claimed);
      if (pending <= 0) continue;
      out.push({
        rule: serializeRule(r),
        clientId: p.clientId,
        clientName: p.clientName,
        clientEmail: p.clientEmail,
        current: p.current,
        threshold,
        earned,
        claimed,
        pending,
      });
    }
  }
  // Most-overdue first (highest pending, then highest current)
  out.sort((a, b) => b.pending - a.pending || b.current - a.current);
  return out;
}

// Top earners per rule for the rule card display.
export async function topEarnersForRule(workspaceId, rule, limit = 3) {
  if (rule.type === 'custom') return [];
  const progress = await clientProgressForRule(workspaceId, rule);
  const threshold = Number(rule.threshold || 0);
  return progress
    .filter((p) => p.current > 0)
    .sort((a, b) => b.current - a.current)
    .slice(0, limit)
    .map((p) => ({
      clientId: p.clientId,
      clientName: p.clientName,
      current: p.current,
      progress: threshold > 0 ? Math.min(1, p.current / threshold) : 0,
    }));
}

// Issue a reward: insert a redemption with status='issued', set expires_at,
// and (optionally) drop a chat message into the client's thread so they know.
// Returns the redemption row + the chat message id (if posted).
export async function issueReward({
  workspaceId, rule, clientId, validityDays = DEFAULT_VALIDITY_DAYS, sendMessage = true,
}) {
  const cl = await sql`
    SELECT id, name, email FROM clients WHERE id = ${clientId} AND workspace_id = ${workspaceId}
  `;
  if (cl.rows.length === 0) throw Object.assign(new Error('Unknown client'), { status: 400 });

  const expires = new Date(Date.now() + Math.max(1, validityDays) * 86400 * 1000).toISOString();
  const rewardText = rule.rewardText || rule.reward_text || rule.name || 'A loyalty reward';

  // Eligibility + double-issue guard for milestone rules. `earned` is how
  // many thresholds the client has crossed; `claimed` is how many
  // redemptions already exist. Issue only while claimed < earned. The
  // count is re-evaluated inside the INSERT so a double-click / retry
  // (whose first write has committed) matches 0 rows and no-ops. 'custom'
  // rules have no threshold and are issued manually by the owner, so they
  // skip this check.
  const threshold = Number(rule.threshold || 0);
  let earned = null;
  if (rule.type !== 'custom' && threshold > 0) {
    const progress = await clientProgressForRule(workspaceId, rule);
    const mine = progress.find((p) => p.clientId === clientId);
    earned = Math.floor(Number(mine?.current || 0) / threshold);
    if (earned <= 0) {
      throw Object.assign(new Error('Client is not eligible for this reward yet'), { status: 400 });
    }
  }

  let ins;
  if (earned != null) {
    ins = await sql`
      INSERT INTO reward_redemptions (
        workspace_id, rule_id, client_id, client_name, reward_text,
        status, expires_at, auto_detected
      )
      SELECT ${workspaceId}, ${rule.id}, ${clientId}, ${cl.rows[0].name}, ${rewardText},
             'issued', ${expires}, TRUE
      WHERE (
        SELECT COUNT(*) FROM reward_redemptions
        WHERE workspace_id = ${workspaceId} AND rule_id = ${rule.id} AND client_id = ${clientId}
      ) < ${earned}
      RETURNING *
    `;
    if (ins.rows.length === 0) {
      throw Object.assign(new Error("This reward was already issued for the client's current milestone"), { status: 400 });
    }
  } else {
    ins = await sql`
      INSERT INTO reward_redemptions (
        workspace_id, rule_id, client_id, client_name, reward_text,
        status, expires_at, auto_detected
      )
      VALUES (
        ${workspaceId}, ${rule.id}, ${clientId}, ${cl.rows[0].name}, ${rewardText},
        'issued', ${expires}, TRUE
      )
      RETURNING *
    `;
  }
  const redemption = ins.rows[0];

  let messageId = null;
  if (sendMessage) {
    const expiryLabel = new Date(expires).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const text =
      `🎉 You've earned a reward!\n\n` +
      `${rewardText}\n\n` +
      `Valid through ${expiryLabel}. Just mention it next time you book.`;

    // Upsert the thread (one per client) and append the message as the biz.
    const threadIns = await sql`
      INSERT INTO message_threads (workspace_id, client_id)
      VALUES (${workspaceId}, ${clientId})
      ON CONFLICT (workspace_id, client_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
      RETURNING id
    `;
    const threadId = threadIns.rows[0].id;

    const msg = await sql`
      INSERT INTO messages (thread_id, sender, text, kind, meta)
      VALUES (${threadId}, 'biz', ${text}, 'reward', ${JSON.stringify({
        redemptionId: redemption.id,
        rewardText,
        expiresAt: expires,
      })}::jsonb)
      RETURNING id
    `;
    messageId = msg.rows[0].id;

    const preview = text.slice(0, 200);
    await sql`
      UPDATE message_threads SET
        last_message_at = NOW(),
        last_message_preview = ${preview},
        unread_client = unread_client + 1
      WHERE id = ${threadId}
    `;
    await sql`
      UPDATE reward_redemptions SET notified_at = NOW() WHERE id = ${redemption.id}
    `;
    redemption.notified_at = new Date().toISOString();

    // Out-of-band nudge (push + email) so a client who doesn't open the
    // portal still learns they earned the reward - the in-app thread
    // message alone went unseen. Best-effort; dynamically imported to
    // avoid an import cycle (rewards.js is pulled in widely). Never block
    // issuance on a notification failure.
    try {
      const { notifyClientSafe } = await import('./push.js');
      await notifyClientSafe({
        clientId, type: 'messages',
        payload: { title: '🎉 You earned a reward', body: rewardText, url: '/me/messages', tag: `reward-${redemption.id}` },
      });
    } catch { /* ignore */ }
    if (cl.rows[0].email) {
      try {
        const [{ sendEmailToClient, emailShell }, { fetchBranding }, { appUrl }] = await Promise.all([
          import('./email.js'), import('./branding.js'), import('./tokens.js'),
        ]);
        const branding = await fetchBranding(workspaceId).catch(() => ({}));
        const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        await sendEmailToClient({
          clientId, type: 'marketing',
          to: cl.rows[0].email,
          replyTo: branding.replyTo,
          subject: `You've earned a reward${branding.businessName ? ` from ${branding.businessName}` : ''}`,
          html: emailShell({
            heading: "🎉 You've earned a reward!",
            body: `<p>Hi ${esc((cl.rows[0].name || '').split(/\s+/)[0] || 'there')},</p>
              <p>${esc(rewardText)}</p>
              <p>Valid through ${esc(expiryLabel)}. Just mention it next time you book.</p>`,
            ctaText: 'Open my portal', ctaUrl: `${appUrl()}/me`,
            branding,
          }),
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[rewards] reward email failed:', e.message);
      }
    }
  }

  return { redemption, messageId };
}

