// GET /api/calendar/public/rebook?token=...&slug=...
//
// Resolves a signed rebook link for the public booking page: which service
// to pick and which day and time to put first (api/_lib/rebook.js). The
// answer carries nothing about the client: no name, email or history, only
// the suggestion and whether it is their own usual rhythm (`usual`), so the
// page can say "Your usual: every 3 weeks on Fridays" only when that is
// true. A forged, expired or foreign-business token is a 404. Works signed
// out. Rate limited by IP like the rest of the public booking API.
import { warmupDbOnce } from '../../_lib/db.js';
import { ensureSchemaApplied } from '../../_lib/ensureSchema.js';
import { enforce, getClientIp } from '../../_lib/rate-limit.js';
import { fetchCalendarSettings } from '../../_lib/calendar.js';
import { loadWorkspaceAccess } from '../../_lib/businessAccess.js';
import { verifyRebookToken, computeRebookSuggestion, usualLine, fmtSuggestionDay } from '../../_lib/rebook.js';
import { methodNotAllowed, notFound, ok, serverError } from '../../_lib/json.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  try {
    res.setHeader('Cache-Control', 'no-store');
    await warmupDbOnce();
    await ensureSchemaApplied();
    const ip = getClientIp(req);
    const blocked = await enforce(req, res, [{ key: `rebook:ip:${ip}`, max: 60, windowSeconds: 600 }]);
    if (blocked) return;
    const token = String(req.query.token || '');
    const slug = String(req.query.slug || '').toLowerCase();
    const t = verifyRebookToken(token);
    if (!t) return notFound(res, 'This link has expired or is not valid');
    const settings = await fetchCalendarSettings(t.workspaceId);
    if (!settings?.slug) return notFound(res, 'This link has expired or is not valid');
    // The link must open the page it was made for.
    if (slug && settings.slug.toLowerCase() !== slug) return notFound(res, 'This link has expired or is not valid');
    const access = await loadWorkspaceAccess(t.workspaceId);
    if (!access.active) return notFound(res, 'This business is not taking bookings right now');
    const sug = await computeRebookSuggestion({ workspaceId: t.workspaceId, clientId: t.clientId, serviceId: t.serviceId });
    if (!sug) return notFound(res, 'That service is no longer available to book');
    return ok(res, {
      rebook: {
        slug: settings.slug,
        serviceId: sug.serviceId,
        date: sug.date,
        startMin: sug.startMin,
        endMin: sug.endMin,
        weeks: sug.weeks,
        weekdayName: sug.weekdayName,
        usual: sug.usual,
        slot: sug.slot,
        usualLine: usualLine(sug),
        pickedLine: sug.startMin != null
          ? `We picked ${fmtSuggestionDay(sug)} for you. Tap Continue, or choose another time.`
          : `We opened ${fmtSuggestionDay(sug)} for you. Choose a time that suits you.`,
      },
    });
  } catch (err) {
    return serverError(res, err);
  }
}
