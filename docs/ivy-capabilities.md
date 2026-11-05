# What Ivy can do

Kayla's standing rule: Ivy can do anything an owner can do in the app, with the owner's approval, while privacy and the guardrails stay intact.

This file is the parity list. Every owner action in the app is listed against Ivy's tools, in one of three states:

- **Ivy does it.** "Approval" means the call is held. The owner sees a card that says exactly what will change and taps Approve. Nothing runs before that tap.
- **Not yet.** Possible and safe, but there is no tool for it yet. Ivy says so plainly and links the screen.
- **Owner only, on purpose.** Ivy never gets a tool for these. The reason is given.

When you add a screen or an owner action, add a row here. Then either give Ivy a tool or record why not.

## Ground rules for every Ivy tool

- **One workspace.** Ivy only runs for a workspace owner. `ensureWorkspace` looks the workspace up by `owner_id`, and a helper-only account gets a 403 from `/api/ivy`, `/api/ivy/stream` and `/api/ivy/approve`. Helpers do not use Ivy at all, so no helper permission can be widened through her. If Ivy is ever opened to helpers, every tool must check the helper's permissions first, the same way `ensureActiveWorkspace(..., { helper })` does in the helper UI.
- **Every lookup is scoped.** Every query is scoped to `ctx.workspaceId`, which comes from the signed-in owner and never from the model's arguments. An id from another workspace reads as "not found".
- **Writes need approval.** Every write in `SENSITIVE_TOOLS` goes through `executeIvyTool`. The call is first checked against the owner's current data (`refuseBeforeApproval`), so an invalid call is refused before any card appears. A valid call is stored in `ivy_pending_actions` with the card text. Only `POST /api/ivy/approve` runs the stored arguments (`api/_lib/ivyApproval.js`), at most once, and within 15 minutes.
  - Older routine "draft" tools still run without a card. They make internal records only: `create_*` drafts, `add_client`, `update_client` (except contact changes), `create_task`, `complete_task`, `mark_invoice_paid`, `toggle_workflow` (except turning on outbound) and `complete_onboarding`.
  - Every tool added under this rule is approval-gated.
- **Truthful ledger.** Every write produces a ledger line from its real result (`ledgerEntry` in `api/_lib/ivyTools.js`).
  - A held call is "waiting", with the card text.
  - A completed call is "done". Website and parity tools word the done line from what the plan actually did.
  - A failed call is "failed", with the reason.
- **Compact schemas.** Tool schemas are sent with every request. Group related operations under one tool with an `action` enum, and keep descriptions short.
  - A grouped tool with a read action (`reminder_settings` get, `cancellation_policy` get, `autopay` status, `client_invite_settings` get) runs that read straight away; every other action is held for approval (`appToolNeedsApproval` in `api/_lib/ivyAppTools.js`).
- **Same code as the button.** A tool calls the server function the app's own screen calls (for example `decideDepositRefund`, `sendDocumentForSigning`, `requestAutopay`). Ivy never has a second copy of money, signing or email logic.

## Website (full editor parity)

Code: `api/_lib/ivyWebsiteTools.js`, plus `api/_lib/websiteVersions.js`, which is shared with Publish and History.

- **Same draft.** Ivy edits the same draft the editor autosaves (`websites.pages` plus the home mirror in `sections`). It applies the same link sanitising as `PUT /api/website`.
- **Same transforms.** Page and section moves call the editor's own `src/features/website/pageTransforms.js`. An Ivy move and an editor move give the same draft, including re-pointed anchor links ("#gallery" buttons now open the page the section moved to).
- **The open editor follows along.** It reloads the draft when the owner approves an Ivy action (the `ivy:actions-ran` event) and when the tab regains focus (`syncFromServer` in `src/features/website/state.js`). The draft that was on screen becomes one undo step, so the owner can undo Ivy's change in the editor. The editor's stored undo history already discards itself when the server draft differs (`restoreHistory`, tested in `tests/website-history.test.mjs`).

| Owner action in the editor | Ivy | Approval card says |
|---|---|---|
| See pages, sections, versions | `get_website` (read) | none (read only) |
| Build a site from a template | `create_website` | Build the website from the "X" template... replaces the draft |
| Edit section text / fields, change layout | `edit_website_section` update | Change the 'Hero' ("...") section on Home: headline to "..." |
| Add a section | `edit_website_section` add | Add a 'FAQ' section to Home (bottom) |
| Remove, hide, show a section | remove / hide / show | Hide the 'Gallery' section on Home (it stays in the draft...) |
| Reorder sections on a page | move (`position` index/top/bottom) | Move the 'Footer' section on Home to top of 5 |
| Duplicate a section | duplicate | Duplicate the 'X' section on Home (the copy goes right below it) |
| Move a section to another page | move_to_page (`target_page`, top/bottom/index) | Move 'Gallery' from Home to About (bottom). 1 button on Home that pointed to it will open the About page instead |
| Move a section onto a new page | move_to_page with `new_page_title` | Move 'Gallery' from Home to Portfolio (a new page at /portfolio) (bottom) |
| Copy a section to another page | copy_to_page | Copy 'FAQ' from Home to About (top) |
| Add, rename, re-slug a page; page SEO | `edit_website_page` add / rename | Add a new page "Pricing" at /pricing with these sections: ... |
| Reorder pages, show/hide in menu | move / show_in_nav / hide_from_nav | Move the Pricing page to position 2 of 4 in the menu |
| Remove a page | remove (home cannot be removed) | Remove the Pricing page (/pricing) and its 3 sections from the draft |
| Look, fonts, business name, site SEO | `update_website` | Change the website look to Bold... These settings show on the live site right away |
| Publish now / schedule / cancel schedule | `publish_website` (`at`, `cancel_schedule`) | Publish the website draft so it is live at ... / Schedule ... to go live on ... |
| Discard draft changes | `restore_website` discard_draft | Throw away every website draft change since you last published... |
| Restore a saved version | `restore_website` restore_version | Put back the website version saved ...: pages go into your draft, look/fonts/SEO apply right away |
| Section style (background, padding, animation) | Not yet | |
| Sticky button, exit popup, redirects, form destinations, favicon, share image, visibility | Not yet | |
| Site handle (public address) | Not yet (changes the public URL; `create_website` sets it on a first build) | |
| Custom domain | Owner only: DNS and domain verification, detaching a verified domain has side effects | |
| Custom HTML / code sections, custom CSS | Owner only: raw code goes straight onto the public site, so only the owner places it, by hand | |

## Calendar and bookings

| Owner action | Ivy |
|---|---|
| See upcoming / search bookings, weekly hours, blocked time | `list_upcoming_bookings`, `search_bookings`, `get_availability` |
| Book an appointment | `create_booking` |
| Add many appointments from a photo or list | `add_bookings_from_list` (approval) |
| Reschedule, cancel (optionally notify) | `reschedule_booking`, `cancel_booking` (approval). Cancelling is the Calendar's cancel: never a fee, a paid deposit goes to Deposits to review (the card says so), a package session and gift card credit go back |
| Deposits to review: refund or keep | `list_deposit_reviews`, `review_deposit_refund` (approval: "Refund Jordan's $20.00 deposit? (cancelled 2 days ahead, your policy refunds it)") |
| Use a package session for a booking made without one | `use_package_session` (approval, says sessions left before and after) |
| Mark completed (with notes) / undo | `update_booking_status` (approval) |
| Mark no-show / undo | `update_booking_status` (approval). Never charges a fee |
| Charge a no-show or late-cancel fee, tips, collect payment | Owner only: moves real money on the client's card |
| Change weekly hours, block a date | `adjust_availability`, `set_availability`, `block_calendar_time` (approval) |
| Remove blocked time | `unblock_calendar_time` (approval) |
| Booking rules (notice, how far ahead, spacing, buffer) | `update_booking_rules` (approval) |
| Services: create | `create_service` |
| Services: edit price, length, name, description, group size, visibility; delete | `manage_service` (approval) |
| Services: deposits, add-ons, custom fields, per-service hours, reminders, intake forms, photo | Not yet |
| Booking reminder settings (clients, your own, one client) | `reminder_settings` get / update (approval: "Clients get reminders 1 day and 1 hour before (was 1 day, 8 hours, 1 hour)") |
| Cancellation policy: wording, switches (require acceptance, booking page, footer, deposit refundable) | `cancellation_policy` get / set_text / set_switches (approval) |
| Policy acceptance records; send the policy for a client to accept | `list_policy_acceptances` (read, no IP addresses), `send_policy_for_acceptance` (approval) |
| Staff list | `list_staff` |
| Add staff, invite a helper login, helper permissions, revoke | Owner only: grants another person access to business and client data |
| Locations / rooms | Not yet |
| Google Calendar connect / disconnect | Owner only: an OAuth connection to a third-party account |
| Share link / embed code | Ivy can tell them where. Nothing to change |
| Waitlist | Not yet |

## Clients

| Owner action | Ivy |
|---|---|
| List, search, quiet clients, leads | `list_clients`, `search_clients`, `list_quiet_clients`, `list_leads` |
| Add a client | `add_client` |
| Edit name, stage, tags, notes | `update_client` |
| Edit email or phone | `update_client` (approval, it changes where messages go) |
| Import a list (file, screenshot, photo) | `import_clients_from_list` (approval, always quiet) |
| "Invite new clients automatically"; resend a portal invite | `client_invite_settings` get / update, `resend_client_invite` (approval) |
| Calendar file / Google events import, "I moved" email | Ivy points to [Import](/clients?import=1) and [Let them know you moved](/clients?announce=1) |
| Message a client | `send_message_to_client` (approval) |
| Archive or change stage in bulk | Not yet (one at a time with `update_client`) |
| Delete clients permanently | Owner only: irreversible, cascades to their history |
| Client photos, files, gallery, folders | Owner only for now: uploads happen on the device |
| Export clients | Owner only: a file download of personal data |

## Finance

| Owner action | Ivy |
|---|---|
| Overdue, search invoices, P&L, expenses | `list_overdue_invoices`, `search_invoices`, `get_pl_summary`, `list_expenses` |
| Draft an invoice / estimate / recurring invoice | `create_invoice`, `create_quote`, `create_recurring_invoice` |
| Send an invoice / estimate | `send_invoice`, `send_quote` (approval) |
| Mark an invoice paid | `mark_invoice_paid` |
| Void, delete, archive, refund invoices | Handled by the invoice update: another builder owns this behaviour and these tools. This pass did not change `void_invoice` or `refund_invoice` |
| Products, expenses, time entries, goals | `create_product`, `create_expense`, `create_time_entry`, `create_goal` |
| Packages | `create_package` (repeated service ids are fine), `use_package_session` (approval) |
| Autopay for recurring invoices | `autopay` status / request / turn_off (request and turn_off approval). Ivy can only ask; only the client approves, in their own portal |
| Gift cards: sell, refund | Owner only: money in and out |
| Memberships: plans, change plan | Not yet (plans touch subscriptions on the payment account) |
| Point of sale, Tap to Pay | Owner only: charges a card in person |
| Connect / disconnect Stripe, Square, PayPal; payouts; tax settings | Owner only: payment accounts and payouts |
| Tax / accounting export | Owner only: a file download |

## Programs (courses and community)

| Owner action | Ivy |
|---|---|
| See programs, members, coupon codes | `list_programs` |
| Create a coupon code | `create_coupon` (approval) |
| Switch a coupon code off | Not yet |
| Create / edit programs, modules, lessons, cohorts, events, check-ins, bundles | Not yet (large structured content; the editor is the right tool for now) |
| Post in the community, moderate members | Not yet. Posting as the owner in a members' space needs its own approval design |
| Refund a program purchase | Owner only: money out |

## Documents and e-sign

| Owner action | Ivy |
|---|---|
| List templates and sent documents | `list_documents` (with each signer's status and a short-lived link to the signed PDF) |
| Draft from a template | `create_document_from_template` |
| Send for signing | `send_document` (approval; same checks and send as the Send button) |
| Send a template to many clients (owner signs first or last) | `send_document_from_template` (approval, up to 50, lists who is skipped) |
| Resend, void a sent document | `resend_document`, `void_document` (approval) |
| Upload a PDF, place fields, self-sign | Owner only: files from the device, and a signature is the owner's own act |

## Marketing, automations, reviews

| Owner action | Ivy |
|---|---|
| Draft / send a campaign | `create_campaign`, `send_campaign` (approval, states the audience size) |
| List, create, switch automations | `list_workflows`, `create_workflow`, `create_suggested_workflow`, `toggle_workflow` (approval when it sends outbound) |
| Delete an automation | `delete_workflow` (approval) |
| Edit an existing automation's steps | Not yet (recreate it with `create_workflow`, then delete the old one) |
| Read reviews | `list_reviews` |
| Reply publicly to a review / remove the reply | `reply_to_review` (approval) |
| Ask for a review | `send_review_request` (approval) |
| Appeal a review | Owner only: a request to the support team in the owner's own words |
| Rewards / loyalty rules, referrals | Not yet |
| Group chats | Not yet |

## Tasks, projects, goals

| Owner action | Ivy |
|---|---|
| List, add, complete tasks | `list_tasks`, `create_task`, `complete_task` |
| Edit, reopen, delete a task | `manage_task` (approval) |
| Projects | `list_projects`, `create_project`. Editing is not yet |
| Goals | `create_goal`. Editing is not yet |

## Account and settings

| Owner action | Ivy |
|---|---|
| Business name, booking address (slug), tagline, time zone, category, email branding (logo, colour, signature), lead instant reply | `update_settings` (approval) |
| Finish setup | `complete_onboarding` |
| Ivy's memory | `remember` (approval), `forget`, `list_memories` |
| Notification preferences | Not yet (personal settings; low value for chat) |
| Password, two-step sign-in, email address | Owner only: account security |
| Subscription, billing, plan changes | Owner only: the owner's own payments to Ivy |
| Export all data, delete the account | Owner only: irreversible or a personal-data download |
| Admin features | Owner only and never reachable: Ivy runs as the owner, not as an admin |
| Anything in another business or another person's account | Never |

## How Ivy talks about the "Owner only" items

The system prompt (`api/_lib/ivy.js`, "WHAT YOU CANNOT DO") sets three rules:

- Ivy must never say "I can't do that directly" about something she has a tool for.
- For an "Owner only" item, Ivy says so in one sentence and links the exact place in the app with an internal link, for example [Account settings](/account), [Finance](/finance) or [Website](/website).
- For a "Not yet" item, Ivy says it plainly and links the screen.

## Tests

- `tests/ivy-website-parity.test.mjs`: every website operation is held before approval, the card text is exact, and the draft equals the editor's transforms after approval. Also covers publish and schedule, discard and restore, invalid input, and workspace isolation.
- `tests/ivy-owner-tools.test.mjs`: each parity tool is held before approval, gives the right result after approval, refuses invalid input, stays inside its workspace, and writes truthful ledger lines.
- `tests/ivy-website-tools.test.mjs`: the original build, edit and publish flow, now with every draft edit approval-gated.
- `tests/ivy-tools-today.test.mjs`: reminders, package sessions, deposits, the cancellation policy, documents, autopay and invites: held before approval, the real effect after, invalid input refused before a card, workspace isolation, ledger text, and `cancel_booking` turning a paid deposit into a review request.
