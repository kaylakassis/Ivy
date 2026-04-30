// Shared serializers + helpers for the rewards feature.
import { sql } from './db.js';

export const VALID_RULE_TYPES = new Set(['visit', 'spend', 'referral', 'custom']);

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
    id:           row.id,
    ruleId:       row.rule_id,
    clientId:     row.client_id,
    clientName:   row.client_name,
    rewardText:   row.reward_text,
    notes:        row.notes,
    redeemedAt:   row.redeemed_at,
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
