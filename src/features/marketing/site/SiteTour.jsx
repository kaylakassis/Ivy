// /tour - every Ivy feature in thirteen short stops.
//
// Each stop is one screen: a kicker (stop number + area), a benefit
// headline, one sentence, an animated mock of that part of the product,
// and a complete chip list of everything in that area. The chips are the
// inventory: if a capability isn't a chip here, it isn't in the product.
// Keep them honest when features change.
//
// Motion is one-time IntersectionObserver reveals (nothing is gated on
// scroll depth), and every mock animation is CSS keyed on the reveal
// class, so the page reads fully on any viewport and under reduced
// motion everything is simply visible.
import { useEffect, useState } from 'react';
import { SiteNav, SiteFooter, usePageMeta, useSiteFonts, BASE_CSS } from './Chrome.jsx';
import { SignupCta } from './Chrome.jsx';

// ─── The tour ──────────────────────────────────────────────────────────
const ACTS = [
  { id: 'run',   label: 'Run the day' },
  { id: 'paid',  label: 'Get paid' },
  { id: 'look',  label: 'Look established' },
  { id: 'ivy',   label: 'Ivy, everywhere' },
];

const STOPS = [
  {
    id: 'dashboard', act: 'run', area: 'Dashboard',
    title: 'Your whole business, one glance.',
    blurb: 'Revenue this month, today’s schedule, what needs attention, and the goals you set, all on the first screen you open.',
    chips: ['Revenue this month', 'Today’s appointments', 'Active clients', 'Booked this month', 'Activity feed', 'Goals that track themselves', 'Tasks with due dates', 'Setup checklist', 'Sample data to try it', 'Daily streak'],
    mock: 'dashboard',
  },
  {
    id: 'clients', act: 'run', area: 'Clients',
    title: 'Every client, and everything about them.',
    blurb: 'A contact list that knows the whole story. Any client can become a folder: their bookings, invoices, estimates and documents in one place.',
    chips: ['Unlimited clients', 'Lead → Active → Paused', 'Tags', 'CSV import', 'Health chips: sessions left, next due, revenue', 'Folders: all their files in one place', 'Private notes', 'Photo gallery per client', 'Referred by', 'Lifetime value', 'Free client portal invite'],
    mock: 'clients',
  },
  {
    id: 'calendar', act: 'run', area: 'Calendar & booking',
    title: 'Clients book themselves.',
    blurb: 'One link shows your real availability. They pick a time, pay the deposit and sign the intake while you’re with someone else.',
    chips: ['Public booking page', 'Services with prices & durations', 'Deposits or full payment at booking', 'Intake forms & signatures in the flow', 'Per-weekday hours & blocked time', 'Reminders by email & SMS: 1 week, 2 days, 1 day, 2 hours', 'Card on file & no-show policy', 'Day, week, month views', 'Google Calendar sync', 'iCal feed to any calendar', 'Share by link, QR or embed', 'Reschedule & cancel with notice rules'],
    mock: 'booking',
  },
  {
    id: 'messages', act: 'run', area: 'Messages',
    title: 'One inbox for every client.',
    blurb: 'Direct threads, group chats, photos and voice memos that transcribe themselves. Clients reply from their free portal or their phone.',
    chips: ['Two-way client threads', 'Group chats', 'Photos & attachments', 'Voice memos with transcription', 'Unread counts & push notifications', 'Instant reply to new leads', 'Message from a client’s profile', 'Ivy drafts replies for approval'],
    mock: 'messages',
  },
  {
    id: 'invoices', act: 'paid', area: 'Invoices & estimates',
    title: 'Invoices that chase themselves.',
    blurb: 'Session ends, the invoice drafts itself. One tap to send, a pay link your client actually uses, and reminders that go out so you never have to.',
    chips: ['Branded invoices', 'Line items, tax & discounts', 'Public pay links, no client login', 'Estimates that become invoices when accepted', 'Recurring invoices', 'Card on file & auto-charge', 'Due-soon & overdue nudges', 'Partial payments & refunds', 'Payments straight to your Stripe', 'Square & PayPal connections coming'],
    mock: 'invoice',
  },
  {
    id: 'sell', act: 'paid', area: 'Sell',
    title: 'Sell in person, in packs, on repeat.',
    blurb: 'Show a QR and they pay on their phone. Sell five-session packs, monthly memberships and gift cards without another app.',
    chips: ['Point of sale with QR pay', 'Services catalog', 'Products', 'Packages with session credits', 'Memberships billed monthly', 'Gift cards', 'Credits tick down as clients book', 'Renewal prompts when credits run low'],
    mock: 'sell',
  },
  {
    id: 'money', act: 'paid', area: 'Expenses, time & taxes',
    title: 'Know your real numbers.',
    blurb: 'Log expenses, bill your hours, and hand your accountant a clean export instead of a shoebox.',
    chips: ['Expense log with categories', 'Billable timers that become invoice lines', 'Revenue vs expenses', 'Schedule-C-ready export', 'QuickBooks & Xero compatible CSV', 'Revenue, client & session goals', 'Conversion & churn analytics'],
    mock: 'money',
  },
  {
    id: 'documents', act: 'look', area: 'Documents & e-signature',
    title: 'Signed, sealed, filed.',
    blurb: 'Waivers, intakes and agreements signed in the app. Both sides get the finished PDF by email, and it lands in the client’s folder.',
    chips: ['10 ready templates: waivers, intake, consent, NDA, coaching agreement, policies', 'Write your own or upload a PDF', 'Legally binding e-signature', 'Countersign yourself', 'Signed PDF emailed to both sides', 'Auto-send when a client books', 'Reminders until it’s signed', 'Filed in the client’s folder'],
    mock: 'documents',
  },
  {
    id: 'website', act: 'look', area: 'Website',
    title: 'A real website, on your domain.',
    blurb: 'Pick a template, publish to yourname.com, and every visitor who fills the form lands in your client list as a lead.',
    chips: ['6 templates', 'Drag-and-drop sections', 'Custom domain', 'Gallery & product store', 'Booking button built in', 'Contact form → new lead', 'SEO & sitemap automatic', 'Traffic analytics', 'Embeddable booking & contact widgets'],
    mock: 'website',
  },
  {
    id: 'marketing', act: 'look', area: 'Marketing',
    title: 'Clients come back on their own.',
    blurb: 'Campaigns for the big announcements, automations for the follow-ups you used to forget, rewards for the regulars, reviews that ask themselves.',
    chips: ['Email campaigns to everyone or a tag', 'Test send & unsubscribe compliance', 'Workflows: new lead, new client, quiet client, booking completed', 'Actions: email, SMS, document, task, invoice draft, wait, tag branches', 'Templates: welcome, intake chase, lead nurture, win-back', 'Rewards for visits, spend & referrals', 'Review requests after sessions', 'Reviews publish to your site; respond or appeal'],
    mock: 'marketing',
  },
  {
    id: 'ivy', act: 'ivy', area: 'Ivy, the assistant',
    title: 'An assistant that actually does things.',
    blurb: 'Ask in plain English. Ivy reads your real numbers, does the work, and waits for your approval on anything that reaches a client.',
    chips: ['100 messages a month included', 'Answers from live data: who hasn’t paid, who’s quiet, what’s booked', 'Sends messages, invoices, estimates & documents', 'Books, reschedules & cancels sessions', 'Adds clients, expenses, tasks & goals', 'Builds automations from one sentence', 'Every outbound action needs your OK', 'Remembers what you tell her', 'Morning briefing of your day', 'Spots habits worth automating', 'Reads files you drop in'],
    mock: 'ivy',
  },
  {
    id: 'phone', act: 'ivy', area: 'iPhone app & client portal',
    title: 'In your pocket, and in theirs.',
    blurb: 'The iPhone app with Face ID and push, and a free portal where your clients book, pay, sign and message you.',
    chips: ['iPhone app', 'Face ID lock', 'Push notifications', 'Same account everywhere', 'Client portal, free forever', 'Clients book & reschedule', 'Clients pay invoices', 'Clients sign documents', 'Clients message you & join groups'],
    mock: 'phone',
  },
];

// Kinetic lines between acts (shown before acts 2, 3 and 4).
const STRIPS = [
  { solid: <>While you worked, <span className="hl">Ivy booked.</span></>, ghost: 'no phone tag · no back-and-forth · no empty slots' },
  { solid: <>Paid on time, <span className="hl">without asking twice.</span></>, ghost: 'invoices · packages · memberships · taxes' },
  { solid: <>You approve. <span className="hl">Ivy does.</span></>, ghost: 'drafts · reminders · follow-ups · automations' },
];
const ACT_GLOW = {
  run:  ['rgba(76,186,127,.16)', 'rgba(34,211,238,.05)'],
  paid: ['rgba(251,191,36,.10)', 'rgba(76,186,127,.08)'],
  look: ['rgba(34,211,238,.08)', 'rgba(76,186,127,.10)'],
  ivy:  ['rgba(76,186,127,.18)', 'rgba(120,200,255,.06)'],
};

// ─── Styles ────────────────────────────────────────────────────────────
const PAGE_CSS = `
.site-root #bgCanvas{position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.5}
.site-root .aurora{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}
.site-root .aurora i{position:absolute;border-radius:50%;filter:blur(90px);opacity:.5}
.site-root .aurora .a1{width:520px;height:520px;background:var(--glow,rgba(76,186,127,.14));top:-10%;left:-8%}
.site-root .aurora .a2{width:640px;height:640px;background:var(--glow2,rgba(34,211,238,.06));bottom:-20%;right:-10%}
.site-root .gridlines{position:absolute;inset:0;pointer-events:none;z-index:0;opacity:.35;background-image:linear-gradient(rgba(243,243,238,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(243,243,238,.025) 1px,transparent 1px);background-size:56px 56px;mask-image:radial-gradient(ellipse 70% 60% at 50% 50%,#000 30%,transparent 75%)}
.site-root .reveal{opacity:0;transform:translateY(22px);transition:opacity .6s ease var(--d,0s),transform .6s ease var(--d,0s)}
.site-root .reveal.in{opacity:1;transform:none}
.site-root .frame.reveal{transform:translateY(30px) scale(.97)}
.site-root .frame.reveal.in{transform:none}

/* opening */
.site-root .t-open{position:relative;min-height:88vh;min-height:88svh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;overflow:hidden;padding:130px 24px 80px}
.site-root .t-open .glow{position:absolute;top:35%;left:50%;transform:translate(-50%,-50%);width:1000px;height:700px;background:radial-gradient(ellipse,rgba(76,186,127,.14) 0%,transparent 60%);pointer-events:none}
.site-root .t-open h1{font-size:clamp(40px,7vw,92px);letter-spacing:-.03em;line-height:1.05}
.site-root .t-open h1 .shimmer{background:linear-gradient(100deg,var(--lime) 30%,#A6E3C3 50%,var(--lime) 70%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shim 3.2s linear infinite}
@keyframes shim{to{background-position:-200% 0}}
.site-root .t-open .sub{font-size:clamp(16px,2vw,21px);color:var(--muted);margin-top:18px;max-width:600px}
.site-root .t-open .meta{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:26px}
.site-root .t-open .meta span{font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--lime);background:var(--tint);border:1px solid rgba(76,186,127,.3);padding:7px 14px;border-radius:999px}
.site-root .t-open .acts{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:34px}
.site-root .t-open .acts a{font-size:13px;color:var(--muted);text-decoration:none;padding:8px 14px;border:1px solid var(--border);border-radius:999px;background:rgba(0,0,0,.2)}
.site-root .t-open .acts a:hover{color:var(--text);border-color:var(--border2)}
.site-root .t-open .hint{position:absolute;bottom:28px;left:50%;transform:translateX(-50%);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);animation:bob 2s infinite}
@keyframes bob{50%{transform:translateX(-50%) translateY(6px)}}

/* ===== SCENES: one full screen each, mock is the star ===== */
.site-root .tour-body{position:relative;z-index:1}
.site-root .scene{position:relative;min-height:100vh;min-height:100svh;display:flex;flex-direction:column;justify-content:center;padding:96px 0 40px;overflow:hidden;scroll-margin-top:0}
.site-root .scene .inner{display:grid;grid-template-columns:.8fr 1.2fr;gap:56px;align-items:center;position:relative;z-index:2}
.site-root .scene.flip .inner{grid-template-columns:1.2fr .8fr}
.site-root .scene.flip .s-copy{order:2}
.site-root .bignum{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-family:var(--head);font-weight:700;font-size:clamp(160px,28vw,420px);letter-spacing:-.05em;color:transparent;-webkit-text-stroke:1px rgba(243,243,238,.06);white-space:nowrap;pointer-events:none;z-index:0;user-select:none}
.site-root .s-kicker{display:inline-flex;align-items:center;gap:10px;font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--lime);margin-bottom:18px}
.site-root .s-kicker .n{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:var(--tint);border:1px solid rgba(76,186,127,.35);font-family:var(--head);font-size:12px;letter-spacing:0}
.site-root .s-copy h2{font-size:clamp(38px,5.2vw,72px);letter-spacing:-.035em;line-height:1.02;margin-bottom:18px;text-wrap:balance}
.site-root .s-copy h2 .hl{color:var(--lime)}
.site-root .s-copy p{font-size:clamp(16px,1.4vw,19px);color:var(--muted);max-width:440px;margin:0}
/* ticker: every capability in the area glides by under the scene */
.site-root .ticker{position:relative;z-index:2;margin-top:44px}
.site-root .ticker .lab{font-size:10.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin:0 auto 10px;max-width:1120px;padding:0 24px}
.site-root .ticker .win{overflow:hidden;-webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent)}
.site-root .ticker .track{display:flex;gap:8px;width:max-content;padding:0 24px;animation:tick var(--dur,40s) linear infinite}
.site-root .ticker:hover .track{animation-play-state:paused}
.site-root .ticker .track span{font-size:13px;color:var(--text);background:rgba(255,255,255,.035);border:1px solid var(--border2);padding:8px 14px;border-radius:999px;white-space:nowrap}
.site-root .ticker .track span::before{content:'✓';color:var(--lime);font-weight:700;margin-right:7px}
@keyframes tick{to{transform:translateX(-50%)}}
/* act strips: kinetic lines between acts */
.site-root .strip{position:relative;padding:120px 24px;text-align:center;overflow:hidden}
.site-root .strip .line{font-family:var(--head);font-weight:700;letter-spacing:-.035em;white-space:nowrap;max-width:100%}
.site-root .strip .line.solid{font-size:clamp(30px,5.5vw,84px);color:var(--text)}
.site-root .strip .line.ghost{font-size:clamp(14px,2.4vw,30px);font-weight:600;margin-top:22px;color:transparent;-webkit-text-stroke:1px rgba(76,186,127,.45)}
.site-root .strip .line .hl{color:var(--lime)}
/* progress dots (desktop) */
.site-root .dots{position:fixed;right:22px;top:50%;transform:translateY(-50%);z-index:60;display:flex;flex-direction:column;gap:10px}
.site-root .dot{position:relative;width:9px;height:9px;border-radius:50%;background:var(--border2);cursor:pointer;transition:.25s;border:none;padding:0}
.site-root .dot.on{background:var(--lime);transform:scale(1.35)}
.site-root .dot::after{content:attr(data-label);position:absolute;right:18px;top:50%;transform:translateY(-50%);font-size:11.5px;color:var(--text);background:rgba(10,16,14,.92);border:1px solid var(--border2);padding:4px 9px;border-radius:7px;white-space:nowrap;opacity:0;pointer-events:none;transition:.2s}
.site-root .dot:hover::after{opacity:1}
/* mobile progress bar */
.site-root .mbar{display:none;position:-webkit-sticky;position:sticky;top:calc(64px + env(safe-area-inset-top,0px));z-index:40;background:rgba(10,16,14,.92);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border-bottom:1px solid var(--border);padding:10px 16px;transition:opacity .25s}
.site-root .mbar.off{opacity:0;pointer-events:none}
.site-root .mbar .row{display:flex;justify-content:space-between;font-size:12px;color:var(--muted)}
.site-root .mbar .row b{color:var(--text);font-weight:600}
.site-root .mbar .track{height:3px;background:var(--border);border-radius:99px;margin-top:8px;overflow:hidden}
.site-root .mbar .fill{height:100%;background:var(--lime);width:0;transition:width .35s ease}

/* device frame + mock primitives */
.site-root .frame{background:var(--panel);border:1px solid var(--border2);border-radius:18px;overflow:hidden;box-shadow:0 40px 100px rgba(0,0,0,.55)}
.site-root .frame-bar{display:flex;align-items:center;gap:7px;padding:11px 16px;background:var(--panel2);border-bottom:1px solid var(--border)}
.site-root .frame-bar span{width:10px;height:10px;border-radius:50%;background:var(--border2)}
.site-root .frame-bar .url{margin-left:10px;flex:1;background:var(--bg);border-radius:6px;font-size:11.5px;color:var(--dim);padding:4px 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.site-root .frame-body{padding:20px}
.site-root .mk-h{font-family:var(--head);font-size:18px;font-weight:600;margin-bottom:3px}
.site-root .mk-sub{font-size:12px;color:var(--dim);margin-bottom:14px}
.site-root .mk-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
.site-root .mk-stat{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:11px 13px}
.site-root .mk-stat .k{font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.site-root .mk-stat .v{font-family:var(--head);font-size:19px;font-weight:600;margin-top:2px}
.site-root .mk-stat .v.lime{color:var(--lime)}
.site-root .mk-list{background:var(--bg);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.site-root .mk-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);font-size:12.5px}
.site-root .mk-row:last-child{border-bottom:none}
.site-root .mk-row .who{color:var(--text);font-weight:500;min-width:0}
.site-root .mk-row .who small{display:block;color:var(--dim);font-weight:400;font-size:11px}
.site-root .chip{font-size:10.5px;font-weight:600;padding:3px 10px;border-radius:999px;white-space:nowrap;flex-shrink:0}
.site-root .chip.g{background:var(--tint);color:var(--lime);border:1px solid rgba(76,186,127,.3)}
.site-root .chip.a{background:rgba(251,191,36,.08);color:#fcd34d;border:1px solid rgba(251,191,36,.25)}
.site-root .chip.n{background:var(--panel2);color:var(--muted);border:1px solid var(--border2)}
.site-root .bar{height:6px;background:var(--border);border-radius:99px;overflow:hidden;margin-top:8px}
.site-root .bar i{display:block;height:100%;width:0;background:var(--lime);border-radius:99px;transition:width 1.4s cubic-bezier(.2,.7,.2,1) .5s}
.site-root .in .bar i{width:var(--w,60%)}
.site-root .st{opacity:0;transform:translateY(8px);transition:opacity .45s ease var(--d,0s),transform .45s ease var(--d,0s)}
.site-root .in .st{opacity:1;transform:none}
.site-root .flip3{position:relative;height:24px;min-width:86px}
.site-root .flip3 span{position:absolute;right:0;top:0;opacity:0;transition:opacity .3s}
.site-root .in .flip3 span:nth-child(1){animation:f3a 5s ease forwards}
.site-root .in .flip3 span:nth-child(2){animation:f3b 5s ease forwards}
.site-root .in .flip3 span:nth-child(3){animation:f3c 5s ease forwards}
@keyframes f3a{0%,28%{opacity:1}34%,100%{opacity:0}}
@keyframes f3b{0%,30%{opacity:0}36%,62%{opacity:1}68%,100%{opacity:0}}
@keyframes f3c{0%,64%{opacity:0}70%,100%{opacity:1}}
.site-root .inv-status{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:5px 14px;border-radius:999px}
.site-root .inv-status.draft{background:var(--panel2);color:var(--muted);border:1px solid var(--border2)}
.site-root .inv-status.sent{background:rgba(251,191,36,.1);color:#fcd34d;border:1px solid rgba(251,191,36,.3)}
.site-root .inv-status.paid{background:var(--lime);color:var(--ink);border:1px solid var(--lime)}
.site-root .mk-svc{display:flex;justify-content:space-between;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:12px 15px;margin-bottom:8px;font-size:13px}
.site-root .mk-svc b{font-weight:600}
.site-root .mk-svc .pr{color:var(--lime);font-weight:600}
.site-root .mk-times{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}
.site-root .mk-time{border:1px solid var(--border2);border-radius:8px;text-align:center;padding:9px 0;font-size:12px;color:var(--muted);transition:.3s}
.site-root .in .mk-time.sel{background:var(--lime);color:var(--ink);font-weight:700;border-color:var(--lime);transition-delay:1.2s}
.site-root .mk-confirm{background:var(--tint);border:1px solid rgba(76,186,127,.35);border-radius:10px;padding:12px 15px;font-size:12.5px;color:var(--text)}
.site-root .mk-confirm b{color:var(--lime)}
.site-root .mk-msg{max-width:88%;padding:10px 14px;border-radius:12px;font-size:12.5px;line-height:1.5;margin-bottom:9px}
.site-root .mk-msg.u{margin-left:auto;background:var(--tint);border:1px solid rgba(76,186,127,.3);border-bottom-right-radius:4px}
.site-root .mk-msg.i{background:var(--panel2);border:1px solid var(--border);border-bottom-left-radius:4px;color:var(--muted)}
.site-root .mk-msg.i b{color:var(--text)}
.site-root .mk-act{display:flex;gap:8px;align-items:center;margin-top:8px;padding:8px 11px;background:rgba(76,186,127,.08);border:1px solid rgba(76,186,127,.25);border-radius:8px;font-size:11.5px;color:var(--lime)}
.site-root .voice{display:flex;align-items:center;gap:8px}
.site-root .voice i{display:inline-flex;gap:2px;align-items:flex-end;height:14px}
.site-root .voice i b{width:3px;background:var(--lime);border-radius:2px;height:40%;animation:vbar 1.1s ease-in-out infinite}
.site-root .voice i b:nth-child(2){height:90%;animation-delay:.15s}.site-root .voice i b:nth-child(3){height:60%;animation-delay:.3s}.site-root .voice i b:nth-child(4){height:100%;animation-delay:.45s}.site-root .voice i b:nth-child(5){height:50%;animation-delay:.6s}
@keyframes vbar{50%{transform:scaleY(.4)}}
.site-root .sig{background:var(--bg);border:1px dashed var(--border2);border-radius:10px;padding:10px 14px;margin:10px 0}
.site-root .sig svg{display:block;width:100%;height:56px}
.site-root .sig path{fill:none;stroke:var(--lime);stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:420;stroke-dashoffset:420}
.site-root .in .sig path{animation:draw 1.6s ease-out .6s forwards}
@keyframes draw{to{stroke-dashoffset:0}}
.site-root .web-hero{background:linear-gradient(160deg,var(--tint),var(--bg));border-radius:10px;padding:28px 22px;text-align:center;margin-bottom:10px;border:1px solid var(--border)}
.site-root .web-hero h4{font-family:var(--head);font-size:20px;font-weight:600;margin-bottom:6px}
.site-root .web-hero p{font-size:12px;color:var(--muted);margin-bottom:12px}
.site-root .web-btn{display:inline-block;background:var(--lime);color:var(--ink);font-size:11.5px;font-weight:700;padding:8px 18px;border-radius:7px}
.site-root .web-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.site-root .web-card{background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:12px;font-size:11.5px;color:var(--muted)}
.site-root .web-card b{display:block;color:var(--text);font-size:12.5px;margin-bottom:3px}
.site-root .wf{display:flex;flex-direction:column;gap:6px}
.site-root .wf .step{display:flex;align-items:center;gap:10px;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:12.5px;transition:border-color .3s,box-shadow .3s}
.site-root .wf .step i{width:22px;height:22px;border-radius:7px;background:var(--panel2);display:inline-flex;align-items:center;justify-content:center;font-style:normal;font-size:11px;color:var(--lime);flex-shrink:0}
.site-root .wf .step small{display:block;color:var(--dim);font-size:10.5px}
.site-root .in .wf .step{animation:wflit 4.5s ease forwards}
.site-root .in .wf .step:nth-child(2){animation-delay:.9s}.site-root .in .wf .step:nth-child(3){animation-delay:1.8s}.site-root .in .wf .step:nth-child(4){animation-delay:2.7s}
@keyframes wflit{0%{border-color:var(--border)}12%,100%{border-color:rgba(76,186,127,.5);box-shadow:0 0 0 3px rgba(76,186,127,.08)}}
.site-root .phone{width:min(260px,80%);margin:0 auto;background:#050807;border:1px solid var(--border2);border-radius:34px;padding:12px;box-shadow:0 40px 100px rgba(0,0,0,.6)}
.site-root .phone .scr{background:var(--panel);border-radius:24px;overflow:hidden;min-height:420px;position:relative;padding:44px 12px 16px}
.site-root .phone .notch{position:absolute;top:10px;left:50%;transform:translateX(-50%);width:90px;height:22px;background:#050807;border-radius:99px}
.site-root .phone .notif{background:rgba(255,255,255,.08);border:1px solid var(--border2);border-radius:14px;padding:10px 12px;font-size:11.5px;color:var(--text);transform:translateY(-70px);opacity:0;transition:transform .7s cubic-bezier(.2,.8,.2,1) .5s,opacity .5s ease .5s}
.site-root .in .phone .notif{transform:none;opacity:1}
.site-root .phone .notif small{display:block;color:var(--dim);font-size:10px;margin-bottom:2px}
.site-root .phone .faceid{display:flex;align-items:center;justify-content:center;gap:8px;margin:26px 0 12px;color:var(--lime);font-size:12px}
.site-root .phone .faceid i{width:36px;height:36px;border:2px solid var(--lime);border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-style:normal;font-size:14px}
.site-root .phone .tabs{position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:space-around;padding:10px 6px 12px;border-top:1px solid var(--border);font-size:9.5px;color:var(--dim)}
.site-root .phone .tabs b{color:var(--lime);font-weight:600}
.site-root .stars{letter-spacing:2px;color:var(--border2)}
.site-root .stars b{color:#fcd34d;font-weight:400}

/* finale */
.site-root .t-final{position:relative;padding:120px 0 100px;text-align:center}
.site-root .t-final::before{content:'';position:absolute;top:35%;left:50%;transform:translate(-50%,-50%);width:900px;height:600px;background:radial-gradient(ellipse,rgba(76,186,127,.12) 0%,transparent 60%);pointer-events:none}
.site-root .t-final h2{font-size:clamp(36px,5.6vw,76px);letter-spacing:-.035em;line-height:1.05;margin-bottom:16px}
.site-root .t-final h2 .pulseglow{color:var(--lime);text-shadow:0 0 40px rgba(76,186,127,.35);animation:pulseg 2.6s ease-in-out infinite}
@keyframes pulseg{50%{text-shadow:0 0 90px rgba(76,186,127,.7)}}
.site-root .t-final p{font-size:18px;color:var(--muted);max-width:560px;margin:0 auto 30px}
.site-root .t-final .cta-row{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.site-root .all-toggle{background:transparent;border:1px solid var(--border2);color:var(--muted);font:inherit;font-size:13.5px;padding:10px 18px;border-radius:999px;cursor:pointer;margin:0 auto 26px;display:inline-flex;align-items:center;gap:8px}
.site-root .all-toggle:hover{color:var(--text)}
.site-root .all{columns:4 220px;column-gap:8px;text-align:left;margin:0 auto 38px;max-width:1040px}
.site-root .all .grp{break-inside:avoid;-webkit-column-break-inside:avoid;margin-bottom:8px;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.site-root .all .grp b{display:block;font-family:var(--head);font-size:13px;font-weight:600;margin-bottom:6px;color:var(--text)}
.site-root .all .grp span{display:block;font-size:11.5px;color:var(--muted);line-height:1.45}

@media(max-width:980px){
  .site-root .scene{min-height:0;padding:64px 0 24px}
  .site-root .scene .inner,.site-root .scene.flip .inner{grid-template-columns:1fr;gap:28px}
  .site-root .scene.flip .s-copy{order:0}
  .site-root .bignum{font-size:38vw;top:22%}
  .site-root .ticker{margin-top:28px}
  .site-root .strip{padding:80px 20px}
  .site-root .dots{display:none}
  .site-root .mbar{display:block}
}
@media(max-width:640px){
  .site-root .t-open{min-height:80svh}
  .site-root .strip .line{white-space:normal}
  .site-root .strip .line.solid{font-size:clamp(28px,8.5vw,40px)}
  .site-root .strip .line.ghost{font-size:clamp(14px,4vw,18px)}
  .site-root .frame-body{padding:14px}
  .site-root .mk-stats{gap:7px}
  .site-root .mk-stat{padding:10px}
  .site-root .mk-stat .v{font-size:17px}
  .site-root .web-grid{grid-template-columns:1fr;gap:8px}
  .site-root .s-copy p{max-width:none}
}
@media (prefers-reduced-motion: reduce){
  .site-root .reveal,.site-root .st{opacity:1!important;transform:none!important;transition:none!important}
  .site-root .t-open .hint,.site-root #bgCanvas{display:none}
  .site-root .t-open h1 .shimmer{animation:none;color:var(--lime)}
  .site-root .t-final h2 .pulseglow{animation:none}
  .site-root .bar i{transition:none;width:var(--w,60%)}
  .site-root .flip3 span{animation:none!important}
  .site-root .flip3 span:nth-child(3){opacity:1}
  .site-root .sig path{animation:none;stroke-dashoffset:0}
  .site-root .wf .step{animation:none;border-color:rgba(76,186,127,.5)}
  .site-root .phone .notif{transition:none;transform:none;opacity:1}
  .site-root .voice i b{animation:none}
  .site-root .mk-time.sel{transition:none}
  .site-root .ticker .track{animation:none;flex-wrap:wrap;width:auto}
  .site-root .ticker .win{mask-image:none;-webkit-mask-image:none}
}
`;

// ─── Mocks ─────────────────────────────────────────────────────────────
function Frame({ url, children }) {
  return (
    <div className="frame reveal" style={{ '--d': '.1s' }}>
      <div className="frame-bar"><span></span><span></span><span></span><div className="url">{url}</div></div>
      <div className="frame-body">{children}</div>
    </div>
  );
}
const st = (i) => ({ '--d': `${0.25 + i * 0.12}s` });

const MOCKS = {
  dashboard: () => (
    <Frame url="joinivy.ai/dashboard">
      <div className="mk-h st" style={st(0)}>Good morning, Maya.</div>
      <div className="mk-sub st" style={st(0)}>Tuesday · 3 appointments · 1 thing to review</div>
      <div className="mk-stats">
        <div className="mk-stat st" style={st(1)}><div className="k">Revenue this month</div><div className="v lime">$4,280</div></div>
        <div className="mk-stat st" style={st(2)}><div className="k">Active clients</div><div className="v">38</div></div>
        <div className="mk-stat st" style={st(3)}><div className="k">Booked</div><div className="v">21</div></div>
      </div>
      <div className="mk-list">
        <div className="mk-row st" style={st(4)}><span className="who">10:00 · Jordan T.<small>Deep tissue · deposit paid</small></span><span className="chip g">today</span></div>
        <div className="mk-row st" style={st(5)}><span className="who">Goal: $5,000 this month<small>$4,280 so far</small><div className="bar" style={{ '--w': '86%' }}><i></i></div></span></div>
        <div className="mk-row st" style={st(6)}><span className="who">Task: send Sam the gallery link<small>due tomorrow</small></span><span className="chip a">open</span></div>
      </div>
    </Frame>
  ),
  clients: () => (
    <Frame url="joinivy.ai/clients">
      <div className="mk-h st" style={st(0)}>Clients</div>
      <div className="mk-sub st" style={st(0)}>Any client can become a folder</div>
      <div className="mk-list">
        <div className="mk-row st" style={st(1)}><span className="who">Maya Reyes<small>Active · VIP · 12 bookings · $1,440 lifetime</small></span><span className="chip g">📁 9 files</span></div>
        <div className="mk-row st" style={st(2)}><span className="who">Sam Kim<small>Active · 2 sessions left · next due Oct 3</small></span><span className="chip g">📁 4 files</span></div>
        <div className="mk-row st" style={st(3)}><span className="who">Priya N.<small>Lead · from your website form</small></span><span className="chip n">+ Make folder</span></div>
      </div>
      <div className="mk-sub st" style={{ ...st(4), marginTop: 12, marginBottom: 6 }}>Inside Maya’s folder</div>
      <div className="mk-list">
        <div className="mk-row st" style={st(5)}><span className="who">3 bookings · 2 invoices · 1 estimate · 3 documents</span><span className="chip g">all in one place</span></div>
      </div>
    </Frame>
  ),
  booking: () => (
    <Frame url="joinivy.ai/book/your-studio">
      <div className="mk-h st" style={st(0)}>Book with Your Studio</div>
      <div className="mk-sub st" style={st(0)}>Choose a service</div>
      <div className="mk-svc st" style={st(1)}><span><b>Deep Tissue Massage</b> · 60 min</span><span className="pr">$120</span></div>
      <div className="mk-svc st" style={st(2)}><span><b>Consultation</b> · 30 min</span><span className="pr">Free</span></div>
      <div className="mk-sub st" style={st(3)}>Thursday, October 8</div>
      <div className="mk-times">
        <div className="mk-time st" style={st(3)}>9:00</div>
        <div className="mk-time st" style={st(3)}>10:30</div>
        <div className="mk-time sel st" style={st(3)}>2:00</div>
        <div className="mk-time st" style={st(3)}>4:30</div>
      </div>
      <div className="mk-confirm st" style={{ '--d': '1.6s' }}><b>✓ Booked.</b> Alex paid a $25 deposit, signed your intake, and gets reminders by email and SMS. It’s on your Google Calendar too.</div>
    </Frame>
  ),
  messages: () => (
    <Frame url="joinivy.ai/messages">
      <div className="mk-msg i st" style={st(0)}><b>Maya:</b> Can I move Thursday to the afternoon?</div>
      <div className="mk-msg u st" style={st(1)}>Of course. 2:00 works, want me to switch it?</div>
      <div className="mk-msg i st" style={st(2)}><div className="voice"><i><b></b><b></b><b></b><b></b><b></b></i> voice memo · 0:06</div><div style={{ marginTop: 6 }}><b>Transcript:</b> “Yes please, two o’clock is perfect, thank you!”</div></div>
      <div className="mk-msg u st" style={st(3)}>Done. Moved to 2:00, reminder updated.<div className="mk-act">✓ booking rescheduled · client notified</div></div>
    </Frame>
  ),
  invoice: () => (
    <Frame url="joinivy.ai/finance">
      <div className="mk-row st" style={{ ...st(0), padding: 0, border: 0, marginBottom: 12 }}>
        <span className="who" style={{ fontFamily: 'var(--head)', fontSize: 16 }}>Invoice #1043 · Sarah M.</span>
        <span className="flip3"><span className="inv-status draft">Draft</span><span className="inv-status sent">Sent</span><span className="inv-status paid">Paid ✓</span></span>
      </div>
      <div className="mk-list st" style={st(1)}>
        <div className="mk-row"><span className="who">Deep Tissue Massage × 3</span><span>$360.00</span></div>
        <div className="mk-row"><span className="who">Due in 14 days · pay link included</span><span></span></div>
        <div className="mk-row"><span className="who" style={{ fontWeight: 600 }}>Total</span><span style={{ fontWeight: 600 }}>$360.00</span></div>
      </div>
      <div className="mk-sub st" style={{ ...st(2), marginTop: 12 }}>Drafted when the session completed · due-soon reminder scheduled · paid straight to your Stripe.</div>
    </Frame>
  ),
  sell: () => (
    <Frame url="joinivy.ai/finance?tab=pos">
      <div className="mk-stats" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="mk-stat st" style={st(0)}><div className="k">Point of sale</div><div className="v">$85.00</div><div className="mk-sub" style={{ marginBottom: 0 }}>Show the QR · they pay on their phone</div></div>
        <div className="mk-stat st" style={st(1)}><div className="k">Gift card</div><div className="v lime">$100</div><div className="mk-sub" style={{ marginBottom: 0 }}>Emailed to the recipient</div></div>
      </div>
      <div className="mk-list">
        <div className="mk-row st" style={st(2)}><span className="who">5-session pack · Sam Kim<small>2 of 5 credits left</small><div className="bar" style={{ '--w': '40%' }}><i></i></div></span><span className="chip a">renew soon</span></div>
        <div className="mk-row st" style={st(3)}><span className="who">Monthly membership · Priya N.<small>$120/mo · renews Oct 1</small></span><span className="chip g">active</span></div>
      </div>
    </Frame>
  ),
  money: () => (
    <Frame url="joinivy.ai/finance?tab=expenses">
      <div className="mk-stats">
        <div className="mk-stat st" style={st(0)}><div className="k">Revenue</div><div className="v lime">$4,280</div></div>
        <div className="mk-stat st" style={st(1)}><div className="k">Expenses</div><div className="v">$610</div></div>
        <div className="mk-stat st" style={st(2)}><div className="k">Billable hours</div><div className="v">31.5</div></div>
      </div>
      <div className="mk-list">
        <div className="mk-row st" style={st(3)}><span className="who">Massage table linens<small>Supplies · $84.00</small></span><span className="chip n">deductible</span></div>
        <div className="mk-row st" style={st(4)}><span className="who">Timer · Jordan T. · 1h 30m<small>became an invoice line</small></span><span className="chip g">billed</span></div>
        <div className="mk-row st" style={st(5)}><span className="who">Schedule-C export<small>QuickBooks & Xero compatible</small></span><span className="chip g">ready</span></div>
      </div>
    </Frame>
  ),
  documents: () => (
    <Frame url="joinivy.ai/sign/…">
      <div className="mk-h st" style={st(0)}>Massage Therapy Intake & Consent</div>
      <div className="mk-sub st" style={st(0)}>Sent to Alex P. · 2 fields to complete</div>
      <div className="sig st" style={st(1)}>
        <svg viewBox="0 0 320 56" aria-hidden="true"><path d="M8 40 C 30 10, 50 10, 70 36 S 110 60, 130 30 S 160 10, 180 34 C 200 52, 220 20, 250 28 S 300 44, 312 30"/></svg>
      </div>
      <div className="mk-list">
        <div className="mk-row st" style={{ '--d': '2.2s' }}><span className="who">Signed by Alex P.<small>Completed PDF emailed to you both</small></span><span className="chip g">completed</span></div>
        <div className="mk-row st" style={{ '--d': '2.5s' }}><span className="who">Filed in Alex’s folder<small>Documents · 1 of 3</small></span><span className="chip n">📁</span></div>
      </div>
    </Frame>
  ),
  website: () => (
    <Frame url="yourstudio.com">
      <div className="web-hero st" style={st(0)}>
        <h4>Your Studio</h4>
        <p>Massage therapy in Portland · book online in 60 seconds</p>
        <span className="web-btn">Book now</span>
      </div>
      <div className="web-grid">
        <div className="web-card st" style={st(1)}><b>Services</b>Deep tissue, sports, prenatal</div>
        <div className="web-card st" style={st(2)}><b>Reviews</b><span className="stars"><b>★★★★★</b></span> “The best hour of my week”</div>
        <div className="web-card st" style={st(3)}><b>Contact</b>Form → your client list, automatically</div>
      </div>
      <div className="mk-sub st" style={{ ...st(4), marginTop: 12, marginBottom: 0 }}>Published · custom domain connected · sitemap submitted · 214 visits this week</div>
    </Frame>
  ),
  marketing: () => (
    <Frame url="joinivy.ai/marketing">
      <div className="mk-sub st" style={st(0)}>Workflow · New client welcome</div>
      <div className="wf st" style={st(0)}>
        <div className="step"><i>⚡</i><span>When a new client signs up<small>trigger</small></span></div>
        <div className="step"><i>✉</i><span>Send the welcome packet to sign<small>document</small></span></div>
        <div className="step"><i>⏱</i><span>Wait 2 days<small>then</small></span></div>
        <div className="step"><i>✓</i><span>Task: call if they haven’t booked<small>for you</small></span></div>
      </div>
      <div className="mk-list" style={{ marginTop: 12 }}>
        <div className="mk-row st" style={st(4)}><span className="who">“Fall openings” campaign<small>to 214 clients · 3 unsubscribed</small></span><span className="chip g">sent</span></div>
        <div className="mk-row st" style={st(5)}><span className="who">Maya hit 10 visits<small>Reward: free add-on · client notified</small></span><span className="chip g">earned</span></div>
        <div className="mk-row st" style={st(6)}><span className="who">Review from Sam K. <span className="stars"><b>★★★★★</b></span><small>requested automatically after the session</small></span><span className="chip g">live</span></div>
      </div>
    </Frame>
  ),
  programs: () => (
    <Frame url="joinivy.ai/programs">
      <div className="mk-h st" style={st(0)}>8-Week Strength Foundations</div>
      <div className="mk-sub st" style={st(0)}>$149 one-time · 12 lessons · community on</div>
      <div className="mk-list">
        <div className="mk-row st" style={st(1)}><span className="who">Week 1 · Setting your baseline<small>video · 12 min</small></span><span className="chip g">watched</span></div>
        <div className="mk-row st" style={st(2)}><span className="who">Week 2 · The program PDF<small>PDF · 6 pages</small></span><span className="chip g">opened</span></div>
        <div className="mk-row st" style={st(3)}><span className="who">Week 3 · Progressions<small>written lesson</small></span><span className="chip n">up next</span></div>
      </div>
      <div className="mk-msg i st" style={{ ...st(4), marginTop: 12, marginBottom: 0 }}><b>Community · Sam K.:</b> First unassisted pull-up today. Week 3 works.</div>
    </Frame>
  ),
  ivy: () => (
    <Frame url="joinivy.ai/ivy">
      <div className="mk-msg u st" style={st(0)}>Who hasn’t paid this month?</div>
      <div className="mk-msg i st" style={st(1)}><b>Sarah M.</b> ($360, due Friday) and <b>Jordan T.</b> ($180, 3 days overdue). Want me to send reminders?</div>
      <div className="mk-msg u st" style={st(2)}>Yes, and remind me to call Jordan tomorrow.</div>
      <div className="mk-msg i st" style={st(3)}>Ready for your approval:<div className="mk-act">✓ reminder → Sarah, Jordan</div><div className="mk-act">✓ task → call Jordan, tomorrow 9am</div></div>
      <div className="mk-sub st" style={{ ...st(4), marginTop: 6, marginBottom: 0 }}>Nothing goes out without your OK.</div>
    </Frame>
  ),
  phone: () => (
    <div className="frame reveal" style={{ '--d': '.1s', background: 'transparent', border: 0, boxShadow: 'none', padding: '10px 0' }}>
      <div className="phone">
        <div className="scr">
          <div className="notch"></div>
          <div className="notif"><small>IVY · now</small>New booking: Alex P., Thu 2:00 PM. Deposit paid.</div>
          <div className="faceid"><i>◉</i> Unlocked with Face ID</div>
          <div className="mk-list">
            <div className="mk-row st" style={st(3)}><span className="who">Client portal · Maya<small>booked, paid, signed, messaged</small></span><span className="chip g">free</span></div>
            <div className="mk-row st" style={st(4)}><span className="who">Push notifications<small>bookings, payments, messages</small></span><span className="chip g">on</span></div>
          </div>
          <div className="tabs"><span><b>Home</b></span><span>Calendar</span><span>Money</span><span>Messages</span><span>Ivy</span></div>
        </div>
      </div>
    </div>
  ),
};

// ─── Page ──────────────────────────────────────────────────────────────
export default function SiteTour() {
  useSiteFonts();
  usePageMeta({
    title: 'Take the Tour - Every Ivy Feature in 13 Stops | Ivy',
    description: 'Scroll through everything Ivy does: dashboard, clients and folders, booking, messages, invoices, point of sale, expenses and taxes, e-signature, website, marketing, the Ivy assistant, and the iPhone app. One plan, $8.99/week.',
    canonical: 'https://joinivy.ai/tour',
    ogType: 'website',
  });
  const [active, setActive] = useState(0);
  // 'before' (hero on screen), 'in' (a stop), 'after' (finale): the phone
  // progress bar only shows during the stops.
  const [phase, setPhase] = useState('before');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cleanups = [];
    const reveals = [...document.querySelectorAll('.site-root .reveal')];
    if (reduceMotion || typeof IntersectionObserver === 'undefined') {
      reveals.forEach((el) => el.classList.add('in'));
    } else {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      }, { threshold: 0.15, rootMargin: '0px 0px -6% 0px' });
      reveals.forEach((el) => io.observe(el));
      cleanups.push(() => io.disconnect());
    }
    // Which stop is nearest the middle of the screen (dots + mobile bar).
    if (typeof IntersectionObserver !== 'undefined') {
      const stops = STOPS.map((s) => document.getElementById('stop-' + s.id)).filter(Boolean);
      const act = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const idx = stops.indexOf(e.target);
          if (idx >= 0) { setActive(idx); setPhase('in'); }
        }
      }, { rootMargin: '-40% 0px -50% 0px' });
      stops.forEach((s) => act.observe(s));
      cleanups.push(() => act.disconnect());
      // Hero and finale: hide the phone progress bar outside the stops.
      const edges = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          if (e.target.id === 'top') setPhase('before');
          else { setPhase('after'); setActive(STOPS.length - 1); }
        }
      }, { rootMargin: '-40% 0px -40% 0px' });
      ['top', 'finale'].forEach((id) => { const el = document.getElementById(id); if (el) edges.observe(el); });
      cleanups.push(() => edges.disconnect());
    }
    return () => cleanups.forEach((fn) => fn());
  }, []);

  // Particle field, skipped under reduced motion.
  useEffect(() => {
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return undefined;
    const cv = document.getElementById('bgCanvas');
    if (!cv) return undefined;
    const cx = cv.getContext('2d');
    let W, H, parts = [], lastY = scrollY, drift = 0, rafId = 0;
    const size = () => { W = cv.width = innerWidth * devicePixelRatio; H = cv.height = innerHeight * devicePixelRatio; cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px'; };
    const seed = () => {
      parts = [];
      const n = Math.min(80, Math.floor(innerWidth / 16));
      for (let i = 0; i < n; i++) parts.push({ x: Math.random() * W, y: Math.random() * H, r: (Math.random() * 1.6 + .5) * devicePixelRatio, vx: (Math.random() - .5) * .12 * devicePixelRatio, vy: (Math.random() - .5) * .12 * devicePixelRatio, depth: Math.random() * .8 + .2, tw: Math.random() * Math.PI * 2 });
    };
    size(); seed();
    const onResize = () => { size(); seed(); };
    addEventListener('resize', onResize);
    const draw = (t) => {
      const dy = scrollY - lastY; lastY = scrollY;
      drift += (Math.max(-30, Math.min(30, dy)) - drift) * .08;
      cx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy - drift * .06 * p.depth * devicePixelRatio;
        if (p.x < -10) p.x = W + 10; if (p.x > W + 10) p.x = -10; if (p.y < -10) p.y = H + 10; if (p.y > H + 10) p.y = -10;
        const a = .18 + .22 * Math.abs(Math.sin(t / 1400 + p.tw)) * p.depth;
        cx.beginPath(); cx.arc(p.x, p.y, p.r * p.depth, 0, Math.PI * 2); cx.fillStyle = 'rgba(76,186,127,' + a.toFixed(3) + ')'; cx.fill();
      }
      rafId = requestAnimationFrame(draw);
    };
    draw(0);
    return () => { cancelAnimationFrame(rafId); removeEventListener('resize', onResize); };
  }, []);

  const go = (e, id) => {
    e.preventDefault();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(id)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };
  const chipCount = STOPS.reduce((n, s) => n + s.chips.length, 0);
  const current = STOPS[active];

  return (
    <div className="site-root">
      <style>{BASE_CSS + PAGE_CSS}</style>
      <canvas id="bgCanvas" aria-hidden="true" />
      <SiteNav active="/tour" />

      {/* OPENING */}
      <section className="t-open" id="top">
        <div className="glow"></div>
        <div className="gridlines"></div>
        <div className="container" style={{ position: 'relative', zIndex: 2 }}>
          <h1>Everything Ivy does, <span className="shimmer">in 13 stops.</span></h1>
          <p className="sub">A day with Ivy, start to finish. Every feature makes an appearance. No signup, no sales call.</p>
          <div className="meta"><span>13 stops</span><span>About 3 minutes</span><span>{chipCount} things Ivy does</span></div>
          <div className="acts">
            {ACTS.map((a) => {
              const first = STOPS.find((s) => s.act === a.id);
              return <a key={a.id} href={'#stop-' + first.id} onClick={(e) => go(e, 'stop-' + first.id)}>{a.label}</a>;
            })}
          </div>
        </div>
        <div className="hint">Scroll ↓</div>
      </section>

      {/* mobile progress */}
      <div className={`mbar${phase === 'in' ? '' : ' off'}`} aria-hidden="true">
        <div className="row"><span>Stop <b>{active + 1}</b> of {STOPS.length}</span><b>{current.area}</b></div>
        <div className="track"><div className="fill" style={{ width: `${((active + 1) / STOPS.length) * 100}%` }}></div></div>
      </div>

      <div className="tour-body">
        {STOPS.map((s, i) => {
          const Mock = MOCKS[s.mock];
          const actIdx = ACTS.findIndex((a) => a.id === s.act);
          const firstOfAct = STOPS.findIndex((x) => x.act === s.act) === i;
          const strip = firstOfAct && actIdx > 0 ? STRIPS[actIdx - 1] : null;
          const glow = ACT_GLOW[s.act];
          return (
            <div key={s.id}>
              {strip && (
                <section className="strip">
                  <div className="gridlines"></div>
                  <div className="line solid reveal">{strip.solid}</div>
                  <div className="line ghost reveal" style={{ '--d': '.15s' }}>{strip.ghost}</div>
                </section>
              )}
              <section className={`scene${i % 2 ? ' flip' : ''}`} id={'stop-' + s.id} style={{ '--glow': glow[0], '--glow2': glow[1] }}>
                <div className="aurora"><i className="a1"></i><i className="a2"></i></div>
                <div className="gridlines"></div>
                <span className="bignum" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                <div className="container inner">
                  <div className="s-copy reveal">
                    <div className="s-kicker"><span className="n">{i + 1}</span>{ACTS[actIdx].label} · {s.area}</div>
                    <h2>{s.title}</h2>
                    <p>{s.blurb}</p>
                  </div>
                  <Mock/>
                </div>
                <div className="ticker reveal" style={{ '--d': '.25s' }} aria-label={`Everything in ${s.area}`}>
                  <div className="lab">Everything in {s.area} · {s.chips.length}</div>
                  <div className="win">
                    <div className="track" style={{ '--dur': `${Math.max(28, s.chips.length * 3.6)}s` }}>
                      {[...s.chips, ...s.chips].map((c, k) => <span key={k}>{c}</span>)}
                    </div>
                  </div>
                </div>
              </section>
            </div>
          );
        })}
      </div>

      {/* FINALE */}
      <section className="t-final" id="finale">
        <div className="container" style={{ position: 'relative' }}>
          <h2 className="reveal">That’s the whole thing.<br /><span className="pulseglow">One plan. One login.</span></h2>
          <p className="reveal" style={{ '--d': '.1s' }}>{chipCount} things across {STOPS.length} areas, all included for $8.99 a week after a 14-day free trial. Nothing locked behind a tier.</p>
          <div className="cta-row reveal" style={{ '--d': '.2s' }}>
            <SignupCta className="btn btn-primary">Start your 14-day free trial</SignupCta>
            <a href="/#video" className="btn" style={{ border: '1px solid var(--border2)', color: 'var(--text)' }}>Watch the 30-second video</a>
          </div>
          <p className="trust reveal" style={{ marginTop: '16px', '--d': '.3s' }}>$0 today · Cancel anytime · Everything included</p>
          <div className="reveal" style={{ marginTop: 34, '--d': '.35s' }}>
            <button type="button" className="all-toggle" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
              {showAll ? 'Hide the full list' : `See all ${chipCount} as a list`} <span aria-hidden="true">{showAll ? '↑' : '↓'}</span>
            </button>
            {showAll && (
              <div className="all">
                {STOPS.map((s) => (
                  <div key={s.id} className="grp"><b>{s.area}</b><span>{s.chips.join(' · ')}</span></div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* progress dots (desktop) */}
      <div className="dots" aria-label="Tour progress">
        {STOPS.map((s, i) => (
          <button key={s.id} type="button" className={`dot${i === active ? ' on' : ''}`} data-label={`${i + 1} · ${s.area}`}
            aria-label={`Go to stop ${i + 1}: ${s.area}`} onClick={(e) => go(e, 'stop-' + s.id)}/>
        ))}
      </div>

      <SiteFooter />
    </div>
  );
}
