// /api/cron/booking-requests - every 10 minutes (vercel.json). Three sweeps:
//   • booking requests whose hold ran out are declined as expired (slot
//     released, client told to pick another time);
//   • waitlist offers whose claim link ran out are closed and the same spot
//     is offered to the next person on the list, while it is still free;
//   • waitlist entries older than 60 days leave the list.
// Auth: Authorization: Bearer $CRON_SECRET from Vercel cron, or
// x-admin-secret for manual runs (api/_lib/cronAuth.js).
import { cronAuthorized } from '../_lib/cronAuth.js';
import { ensureSchemaApplied } from '../_lib/ensureSchema.js';
import { trackCron } from '../_lib/cronMetrics.js';
import { expireBookingRequests } from '../_lib/bookingRequests.js';
import { sweepWaitlistOffers, expireWaitlistEntries } from '../_lib/waitlist.js';
import { ok, serverError, unauthorized } from '../_lib/json.js';

// Exported so tests and the admin can run one pass without HTTP.
export async function runBookingRequestSweep() {
  const expiredRequests = await expireBookingRequests({ limit: 300 });
  const offers = await sweepWaitlistOffers({ limit: 300 });
  const expiredEntries = await expireWaitlistEntries();
  return { expiredRequests, offersExpired: offers.expired, offersReoffered: offers.reoffered, expiredEntries };
}

async function handler(req, res) {
  if (!(await cronAuthorized(req))) return unauthorized(res);
  try {
    await ensureSchemaApplied();
    const out = await runBookingRequestSweep();
    return ok(res, out);
  } catch (err) {
    return serverError(res, err);
  }
}

export default trackCron('booking-requests', handler);
