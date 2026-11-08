// Ivy tool for shop pages (api/_lib/shops.js), wired into ivyAppTools.js.
//
// One grouped tool, `shop`. `get` reads and runs at once; every other
// action is held for the owner's approval and calls the same server
// functions the Shops screen calls. Every lookup is scoped to
// ctx.workspaceId (the signed-in owner), never to an id in the arguments:
// a shop the owner does not run reads as "not found", and a member's own
// actions (accept, decline, leave) only ever touch the owner's own row.
import { sql } from './db.js';
import {
  shopsForWorkspace, loadOwnedShop, createShop, updateShop, setShopStatus, inviteMember, updateRoster, removeMember,
  leaveShop, acceptInvite, declineInvite, listMembers, serializeShop, serializeMember, shopStats, memberStats,
  cleanShopPatch, teamHoursUnion, hoursLinesText, isUuid, SHOP_AMENITIES, SHOP_THEMES, SHARED_ON_SHOP, NEVER_ON_SHOP, SHOP_PLAN_NOTE,
} from './shops.js';

export const SHOP_READ_ACTIONS = ['get'];

export const SHOP_TOOLS = [
  {
    name: 'shop',
    description: "Shop pages: one location, several independent Ivy businesses on one public page (/shop/slug). get: the owner's shop pages, roster with booking counts, memberships and waiting invites. create (name, slug), update (fields), publish, unpublish, invite (email), reorder (member_ids in order), feature (member_id, featured), remove_member, accept_invite / decline_invite (invite_id), leave (shop_id). Money, clients and messages are never pooled.",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'create', 'update', 'publish', 'unpublish', 'invite', 'reorder', 'feature', 'remove_member', 'accept_invite', 'decline_invite', 'leave'] },
        shop_id: { type: 'string', description: 'From get. Optional when the owner runs exactly one shop page.' },
        name: { type: 'string' },
        slug: { type: 'string', description: 'Web address part: lowercase letters, digits, hyphens' },
        tagline: { type: 'string' },
        description: { type: 'string' },
        address_label: { type: 'string' },
        city: { type: 'string' },
        phone: { type: 'string' },
        amenities: { type: 'array', items: { type: 'string' }, description: `Ids from: ${SHOP_AMENITIES.map((a) => a.id).join(', ')}` },
        theme: { type: 'string', enum: SHOP_THEMES },
        first_available: { type: 'boolean' },
        show_prices: { type: 'boolean' },
        show_reviews: { type: 'boolean' },
        booking_rules_note: { type: 'string' },
        hours: { type: 'object', description: 'update: door hours as {"0":[{"start":540,"end":1020}],...}, weekday 0 = Sunday, minutes from midnight; [] = closed' },
        match_team_hours: { type: 'boolean', description: 'update: set the door hours to when anyone on the page takes bookings' },
        email: { type: 'string', description: 'invite: the pro to invite' },
        member_id: { type: 'string' },
        member_ids: { type: 'array', items: { type: 'string' }, description: 'reorder: every member id in the new order' },
        featured: { type: 'boolean' },
        invite_id: { type: 'string', description: 'accept_invite / decline_invite: from get (invites)' },
      },
      required: ['action'],
    },
  },
];

const clip = (s, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

async function ownerEmail(ctx) {
  if (!ctx?.userId) return null;
  const r = await sql`SELECT email FROM users WHERE id = ${ctx.userId}`;
  return r.rows[0]?.email || null;
}

export async function readShop(ws, _args, ctx) {
  const data = await shopsForWorkspace(ws, await ownerEmail(ctx));
  const owned = [];
  for (const s of data.owned) {
    const row = await loadOwnedShop(s.id, ws);
    const stats = await shopStats(row);
    const members = await listMembers(s.id);
    owned.push({
      ...s,
      stats: { pageViews: stats.pageViews, bookingsTotal: stats.total, bookingsLast30: stats.last30 },
      roster: members.map((m) => ({
        ...serializeMember(m, { owner: true }),
        bookings: m.workspace_id ? (stats.byWorkspace[m.workspace_id] || { total: 0, last30: 0, upcoming: 0 }) : null,
      })),
    });
  }
  const memberships = [];
  for (const m of data.memberships) {
    memberships.push({ ...m, myBookings: m.member.status === 'active' ? await memberStats(m.shop.id, ws) : null });
  }
  return {
    owned, memberships, invites: data.invites,
    shared: SHARED_ON_SHOP, never_shared: NEVER_ON_SHOP, plan_note: SHOP_PLAN_NOTE,
    manage: '[Shops](/shops)',
  };
}

async function resolveShop(ws, a) {
  if (a.shop_id) {
    if (!isUuid(String(a.shop_id))) throw new Error('shop_id is not valid (get it from shop get)');
    const s = await loadOwnedShop(String(a.shop_id), ws);
    if (!s) throw new Error('Shop page not found');
    return s;
  }
  const { rows } = await sql`SELECT * FROM shops WHERE owner_workspace_id = ${ws} ORDER BY created_at ASC`;
  if (rows.length === 1) return rows[0];
  if (!rows.length) throw new Error('You do not run a shop page yet (create one first)');
  throw new Error('You run more than one shop page: pass shop_id');
}

function patchFrom(a) {
  const body = {};
  for (const k of ['name', 'slug', 'tagline', 'description', 'phone', 'city', 'amenities']) if (a[k] != null) body[k] = a[k];
  if (a.address_label != null) body.addressLabel = a.address_label;
  const settings = {};
  if (a.theme != null) settings.theme = a.theme;
  if (a.first_available != null) settings.firstAvailable = a.first_available;
  if (a.show_prices != null) settings.showPrices = a.show_prices;
  if (a.show_reviews != null) settings.showReviews = a.show_reviews;
  if (a.booking_rules_note != null) settings.bookingRulesNote = a.booking_rules_note;
  return { body, settings };
}

const FIELD_WORDS = { name: 'name', slug: 'web address', tagline: 'tagline', description: 'description', phone: 'phone', city: 'city', amenities: 'amenities', address_label: 'address' };

export async function planShop(ws, a, ctx) {
  const action = String(a.action || '');
  if (action === 'get') throw new Error('get is a read');

  if (action === 'create') {
    const { body, settings } = patchFrom(a);
    if (Object.keys(settings).length) body.settings = settings;
    cleanShopPatch(body, { create: true }); // refuse bad input before any card
    return {
      summary: `Create the shop page "${clip(body.name)}" at /shop/${body.slug}. It starts as a draft with your business as its first member; nothing is public until you publish it.`,
      done: `Created the shop page "${clip(body.name)}" (draft)`,
      apply: async () => {
        const shop = await createShop({ workspaceId: ws, body });
        return { ok: true, shop: serializeShop(shop, { owner: true }) };
      },
    };
  }

  if (action === 'update') {
    const shop = await resolveShop(ws, a);
    const { body, settings } = patchFrom(a);
    const current = serializeShop(shop, { owner: true });
    if (Object.keys(settings).length) body.settings = { ...current.settings, ...settings };
    if (a.match_team_hours === true) body.hours = teamHoursUnion(await listMembers(shop.id));
    else if (a.hours != null) body.hours = a.hours;
    if (!Object.keys(body).length) throw new Error('Nothing to change');
    cleanShopPatch(body);
    const parts = [];
    for (const [k, w] of Object.entries(FIELD_WORDS)) {
      const key = k === 'address_label' ? 'addressLabel' : k;
      if (key in body) parts.push(`${w} to "${clip(Array.isArray(body[key]) ? body[key].join(', ') : body[key], 80)}"`);
    }
    if ('hours' in body) {
      const clean = cleanShopPatch({ hours: body.hours }).hours;
      body.hours = clean;
      parts.push(`opening hours to ${hoursLinesText(clean)}${a.match_team_hours === true ? " (when the team takes bookings)" : ''}`);
    }
    for (const [k, v] of Object.entries(settings)) parts.push(`${k.replace(/([A-Z])/g, ' $1').toLowerCase()} to ${typeof v === 'boolean' ? (v ? 'on' : 'off') : `"${clip(v, 80)}"`}`);
    return {
      summary: `Change the shop page "${clip(shop.name)}": ${parts.join('; ')}.`,
      done: `Updated the shop page "${clip(shop.name)}"`,
      apply: async () => ({ ok: true, shop: serializeShop(await updateShop({ shop, body }), { owner: true }) }),
    };
  }

  if (action === 'publish' || action === 'unpublish') {
    const shop = await resolveShop(ws, a);
    const status = action === 'publish' ? 'published' : 'draft';
    if (shop.status === status) throw new Error(`"${clip(shop.name)}" is already ${status === 'published' ? 'published' : 'unpublished'}`);
    return {
      summary: status === 'published'
        ? `Publish the shop page "${clip(shop.name)}" at /shop/${shop.slug}. Visitors can then see every listed member and book them.`
        : `Unpublish the shop page "${clip(shop.name)}". The page goes dark until you publish it again; members keep their own booking pages.`,
      done: `${status === 'published' ? 'Published' : 'Unpublished'} the shop page "${clip(shop.name)}"`,
      apply: async () => ({ ok: true, shop: serializeShop(await setShopStatus({ shop, status }), { owner: true }) }),
    };
  }

  if (action === 'invite') {
    const shop = await resolveShop(ws, a);
    const email = String(a.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('email is required');
    return {
      summary: `Invite ${email} to be listed on "${clip(shop.name)}". They get an email that says what the page shows (${SHARED_ON_SHOP.map((s) => s.toLowerCase()).join('; ')}) and what it never shows (${NEVER_ON_SHOP.map((s) => s.toLowerCase()).join(', ')}). Nothing appears until they accept.`,
      done: `Invited ${email} to "${clip(shop.name)}"`,
      apply: async () => {
        const inviter = ctx?.userId ? (await sql`SELECT id, email FROM users WHERE id = ${ctx.userId}`).rows[0] : null;
        const out = await inviteMember({ shop, email, inviterUser: inviter });
        return { ok: true, sent: out.sent, has_account: out.hasAccount, expires_at: out.expiresAt, member: serializeMember(out.member, { owner: true }), ...(out.sent ? {} : { done: `Added ${email} to the roster as invited, but the email was not sent (${out.reason || 'the email service did not answer'})` }) };
      },
    };
  }

  if (action === 'reorder' || action === 'feature' || action === 'remove_member') {
    const shop = await resolveShop(ws, a);
    const members = await listMembers(shop.id);
    const nameOf = (m) => m.biz_name || m.invite_email || 'a business';
    if (action === 'reorder') {
      const ids = Array.isArray(a.member_ids) ? a.member_ids.map(String) : [];
      if (!ids.length) throw new Error('member_ids is required (every member id in the new order)');
      const byId = Object.fromEntries(members.map((m) => [m.id, m]));
      for (const id of ids) if (!byId[id]) throw new Error('A member id is not on this shop page');
      const items = ids.map((id, i) => ({ id, displayOrder: i + 1 }));
      return {
        summary: `Reorder the team on "${clip(shop.name)}": ${ids.map((id) => nameOf(byId[id])).join(', ')}.`,
        done: `Reordered the team on "${clip(shop.name)}"`,
        apply: async () => ({ ok: true, members: (await updateRoster({ shop, items })).map((m) => serializeMember(m, { owner: true })) }),
      };
    }
    const id = String(a.member_id || '');
    const m = members.find((x) => x.id === id);
    if (!m) throw new Error('member_id is required (from shop get)');
    if (action === 'feature') {
      if (typeof a.featured !== 'boolean') throw new Error('featured must be true or false');
      return {
        summary: a.featured ? `Feature ${nameOf(m)} at the top of "${clip(shop.name)}".` : `Stop featuring ${nameOf(m)} on "${clip(shop.name)}".`,
        done: `${a.featured ? 'Featured' : 'Unfeatured'} ${nameOf(m)} on "${clip(shop.name)}"`,
        apply: async () => ({ ok: true, members: (await updateRoster({ shop, items: [{ id, featured: a.featured }] })).map((x) => serializeMember(x, { owner: true })) }),
      };
    }
    if (m.role === 'owner') throw new Error('The shop owner stays on the page');
    return {
      summary: m.status === 'invited'
        ? `Cancel the invite for ${nameOf(m)} to "${clip(shop.name)}".`
        : `Remove ${nameOf(m)} from "${clip(shop.name)}". Their listing comes off the page right away; their own booking page is unchanged. They are told.`,
      done: m.status === 'invited' ? `Cancelled the invite for ${nameOf(m)}` : `Removed ${nameOf(m)} from "${clip(shop.name)}"`,
      apply: async () => ({ ok: true, ...(await removeMember({ shop, memberId: id })) }),
    };
  }

  if (action === 'accept_invite' || action === 'decline_invite') {
    const email = await ownerEmail(ctx);
    const data = await shopsForWorkspace(ws, email);
    const inv = data.invites.find((i) => i.inviteId === String(a.invite_id || '')) || (data.invites.length === 1 && !a.invite_id ? data.invites[0] : null);
    if (!inv) throw new Error(data.invites.length ? 'invite_id is required (from shop get)' : 'No shop page invite is waiting for you');
    const member = (await sql`SELECT * FROM shop_members WHERE id = ${inv.inviteId}`).rows[0];
    const shop = (await sql`SELECT * FROM shops WHERE id = ${inv.shop.id}`).rows[0];
    if (!member || !shop || member.status !== 'invited') throw new Error('That invite is no longer waiting');
    const found = { kind: 'member', shop, member };
    const user = ctx?.userId ? (await sql`SELECT id, email FROM users WHERE id = ${ctx.userId}`).rows[0] : null;
    if (!user) throw new Error('No signed-in owner');
    if (action === 'accept_invite') {
      return {
        summary: `Accept the invite from "${clip(shop.name)}". Your listing (${SHARED_ON_SHOP.map((s) => s.toLowerCase()).join('; ')}) goes on their shop page. ${NEVER_ON_SHOP.join(', ').toLowerCase()} are never shown. You can leave with one tap any time.`,
        done: `Joined the shop page "${clip(shop.name)}"`,
        apply: async () => {
          const out = await acceptInvite({ found, user });
          return { ok: true, shop: serializeShop(out.shop), already_member: !!out.alreadyMember };
        },
      };
    }
    return {
      summary: `Decline the invite from "${clip(shop.name)}". They are told; nothing of yours goes on their page.`,
      done: `Declined the invite from "${clip(shop.name)}"`,
      apply: async () => ({ ok: true, ...(await declineInvite({ found, user })) }),
    };
  }

  if (action === 'leave') {
    if (!isUuid(String(a.shop_id || ''))) throw new Error('shop_id is required (from shop get, memberships)');
    const m = (await sql`SELECT sm.*, s.name FROM shop_members sm JOIN shops s ON s.id = sm.shop_id WHERE sm.shop_id = ${String(a.shop_id)} AND sm.workspace_id = ${ws} AND sm.status = 'active'`).rows[0];
    if (!m) throw new Error('You are not listed on that shop page');
    if (m.role === 'owner') throw new Error('You run this shop page, so you cannot leave it (unpublish or delete it instead)');
    return {
      summary: `Leave the shop page "${clip(m.name)}". Your listing comes off right away and nothing of yours stays on it. The shop owner is told.`,
      done: `Left the shop page "${clip(m.name)}"`,
      apply: async () => ({ ok: true, ...(await leaveShop({ shopId: String(a.shop_id), workspaceId: ws })) }),
    };
  }

  throw new Error('action must be one of get, create, update, publish, unpublish, invite, reorder, feature, remove_member, accept_invite, decline_invite, leave');
}
