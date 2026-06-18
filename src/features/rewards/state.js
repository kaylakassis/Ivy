// API-backed rewards store: settings, rules, redemptions, KPIs.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';

export function useRewards() {
  const [data, setData] = useState({
    settings: { launched: false, launchedAt: null },
    rules: [],
    redemptions: [],
    kpis: { activeMembers: 0, rewardsRedeemed: 0, referralsConverted: 0, repeatRevenue: 0 },
    pending: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const refresh = useCallback(async () => {
    const r = await api.get('/rewards');
    setData(r.rewards);
    return r.rewards;
  }, []);

  useEffect(() => {
    let live = true;
    api.get('/rewards')
      .then((r) => live && setData(r.rewards))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  const setLaunched = useCallback(async (launched) => {
    const r = await api.patch('/rewards', { launched });
    setData((d) => ({ ...d, settings: r.settings }));
  }, []);

  const createRule = useCallback(async (input) => {
    const r = await api.post('/rewards/rules', input);
    setData((d) => ({ ...d, rules: [r.rule, ...d.rules] }));
    return r.rule;
  }, []);
  const updateRule = useCallback(async (id, patch) => {
    const r = await api.patch('/rewards/rules/' + id, patch);
    setData((d) => ({ ...d, rules: d.rules.map((x) => x.id === id ? r.rule : x) }));
    return r.rule;
  }, []);
  const removeRule = useCallback(async (id) => {
    await api.del('/rewards/rules/' + id);
    setData((d) => ({ ...d, rules: d.rules.filter((x) => x.id !== id) }));
  }, []);

  const logRedemption = useCallback(async (input) => {
    const r = await api.post('/rewards/redemptions', input);
    setData((d) => ({
      ...d,
      redemptions: [r.redemption, ...d.redemptions],
      kpis: { ...d.kpis, rewardsRedeemed: d.kpis.rewardsRedeemed + 1 },
    }));
    // Refresh KPIs in background - they depend on aggregations.
    refresh().catch(() => {});
    return r.redemption;
  }, [refresh]);

  const removeRedemption = useCallback(async (id) => {
    await api.del('/rewards/redemptions/' + id);
    setData((d) => ({
      ...d,
      redemptions: d.redemptions.filter((x) => x.id !== id),
      kpis: { ...d.kpis, rewardsRedeemed: Math.max(0, d.kpis.rewardsRedeemed - 1) },
    }));
    refresh().catch(() => {});
  }, [refresh]);

  const markRedemptionStatus = useCallback(async (id, status) => {
    const r = await api.patch('/rewards/redemptions/' + id, { status });
    setData((d) => ({
      ...d,
      redemptions: d.redemptions.map((x) => x.id === id ? r.redemption : x),
    }));
    return r.redemption;
  }, []);

  // Confirms an auto-detected eligibility: writes a redemption + DMs the client.
  // Refreshes the whole rewards payload so pending/redemptions/KPIs all settle.
  const confirmPending = useCallback(async ({ ruleId, clientId, validityDays = 30, sendMessage = true }) => {
    const r = await api.post('/rewards/confirm', { ruleId, clientId, validityDays, sendMessage });
    await refresh();
    return r.redemption;
  }, [refresh]);

  const dismissPending = useCallback(async ({ ruleId, clientId }) => {
    await api.post('/rewards/dismiss', { ruleId, clientId });
    await refresh();
  }, [refresh]);

  return {
    ...data, loading, error, refresh,
    setLaunched, createRule, updateRule, removeRule,
    logRedemption, removeRedemption, markRedemptionStatus,
    confirmPending, dismissPending,
  };
}
