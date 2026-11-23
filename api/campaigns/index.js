// Email campaigns were retired (November 2026). Nothing is sent from here
// any more and there is no screen for them. These addresses still answer so
// that an iPhone app from before the removal shows an empty list and a plain
// sentence instead of an error. Campaigns already written stay in the
// database (email_campaigns); nothing was deleted.
import { requireSameOrigin } from '../_lib/security.js';
import { requireUser } from '../_lib/auth.js';

export const RETIRED_MESSAGE = 'Email campaigns are no longer part of Ivy. Nothing was sent.';

export default async function handler(req, res) {
  if (!requireSameOrigin(req, res)) return undefined;
  const user = await requireUser(req, res);
  if (!user) return undefined;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return res.status(200).json({ campaigns: [], retired: true });
  return res.status(410).json({ error: RETIRED_MESSAGE, code: 'feature-retired' });
}
