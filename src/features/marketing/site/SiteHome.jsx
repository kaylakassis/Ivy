// Marketing home page, ported pixel-faithful from the ivy-site-handoff
// prototype (index.html). Chrome (nav/footer/sticky CTA/meta/fonts) comes
// from Chrome.jsx; page-specific CSS + interactivity live here.
import { useEffect, useRef, useState } from 'react';
import { SiteNav, SiteFooter, StickyCta, usePageMeta, useSiteFonts, BASE_CSS } from './Chrome.jsx';

const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': 'https://joinivy.ai/#org',
      name: 'Ivy',
      url: 'https://joinivy.ai',
      description: 'Ivy is the all-in-one business platform for solopreneurs, with an AI assistant that does your busywork.',
    },
    {
      '@type': 'SoftwareApplication',
      name: 'Ivy',
      url: 'https://joinivy.ai',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web, iOS, Android',
      description: "All-in-one business platform for solo service businesses: online booking, invoicing, client CRM, e-signature, two-way messaging, email campaigns, website builder, and an AI assistant that performs real tasks. No transaction fees - payments go directly to the owner's Stripe account.",
      offers: [
        { '@type': 'Offer', price: '8.99', priceCurrency: 'USD', description: '$8.99 per week after a 14-day free trial ($0 today)' },
        { '@type': 'Offer', price: '375', priceCurrency: 'USD', description: 'Annual plan, $375/year (save about 20%)' },
      ],
      publisher: { '@id': 'https://joinivy.ai/#org' },
    },
  ],
};

/* ---- Persona picker data: rewrites the pain cards per profession ---- */
const P = {
  default: {
    p1h: "The session was nine days ago.", p1p: "You've thought about it in the shower twice. Opening the invoice app, finding the client, retyping the line items - it keeps losing to literally everything else.",
    p2h: "2pm came and went. Nobody showed.", p2p: "No card on file, no reminder went out, and your cancellation policy lives in an Instagram bio nobody reads. That slot is just... gone.",
    p3h: "\"Did they ever sign the intake form?\"", p3p: "You're scrolling months of texts and three email accounts five minutes before the appointment, again.",
    p4h: "You notice two months too late.", p4p: "They used to book every three weeks. No falling-out, no goodbye - they just drifted, and nothing in your stack was watching."
  },
  therapist: {
    p1h: "Tuesday's session still isn't invoiced.", p1p: "Between sessions, notes, and actual life, the invoice keeps sliding to \"tonight\" - and tonight keeps not happening.",
    p2h: "Your 4pm didn't show. Again.", p2p: "That's a full session gone, no card on file, and a cancellation policy that's never once enforced itself.",
    p3h: "\"Did they return the intake paperwork?\"", p3p: "New client in ten minutes, and you're digging through your inbox for a consent form you're pretty sure you sent.",
    p4h: "A weekly client becomes a memory.", p4p: "They tapered off without a word. By the time you notice the gap in your calendar, it's been six weeks."
  },
  coach: {
    p1h: "The package ended. The invoice didn't go out.", p1p: "Session 6 of 6 wrapped last week. The renewal conversation and the final invoice are both still in your head, not their inbox.",
    p2h: "They \"forgot\" the call. You ate the hour.", p2p: "No reminder, no card on file, no rescheduling policy anyone can point to - just a blank Zoom room and a lost slot.",
    p3h: "\"Did they sign the coaching agreement?\"", p3p: "You're about to start session two and you're honestly not sure the contract ever came back signed.",
    p4h: "A client goes dark between packages.", p4p: "They finished strong, said they'd \"be in touch about round two,\" and vanished. Nothing followed up, because you're the follow-up system."
  },
  stylist: {
    p1h: "The color correction ran long - the charge didn't.", p1p: "You added product and an extra 40 minutes, then never updated the total. That's real money left on the chair.",
    p2h: "Saturday's 1pm ghosted your busiest day.", p2p: "Your best slot of the week, empty. No card on file, no deposit, and the no-show fee in your bio has never once been collected.",
    p3h: "\"Did they fill out the color history form?\"", p3p: "You're mixing in five minutes and still don't know about the box dye from last summer.",
    p4h: "A regular quietly switches chairs.", p4p: "Every six weeks for two years, then nothing. You spot it three months later - and by then rebooking feels awkward."
  },
  photographer: {
    p1h: "The gallery's delivered. The final invoice isn't.", p1p: "You nailed the shoot, edited for a week, sent the gallery - and the balance payment is still sitting in drafts.",
    p2h: "Golden hour, no client.", p2p: "They forgot the session. No deposit taken, no reminder sent, and the light you scouted for a week is gone.",
    p3h: "\"Did they sign the print release?\"", p3p: "The client's asking to publish, and you're excavating email threads to find whether the contract covered usage.",
    p4h: "Last year's wedding clients forgot you exist.", p4p: "Anniversary shoots, family sessions, referrals - all sitting in a spreadsheet you haven't opened since delivery."
  },
  trainer: {
    p1h: "Session 10 of the 10-pack happened. Nobody noticed.", p1p: "They're training on sessions they haven't bought yet, and the renewal invoice is still a mental note.",
    p2h: "6am slot. Empty gym. You still drove there.", p2p: "No card on file, no late-cancel fee, no reminder - just you, awake for nothing.",
    p3h: "\"Did they sign the liability waiver?\"", p3p: "New client's warming up and you're not 100% sure the PAR-Q ever came back.",
    p4h: "January's most motivated client is gone by March.", p4p: "They missed one week, then two. Nothing pinged you until the habit - and the revenue - was already gone."
  },
  contractor: {
    p1h: "The job's done. The invoice is \"tonight's problem.\"", p1p: "You finished Thursday, got pulled to the next site Friday, and the invoice is still riding around in your truck's mental glovebox.",
    p2h: "Homeowner wasn't home for the walkthrough.", p2p: "An hour of drive time, no confirmation the day before, and now the whole week's schedule dominoes.",
    p3h: "\"Did they sign off on the change order?\"", p3p: "Scope grew, price grew, and the approval lives in a text thread you'd rather not rely on if this goes sideways.",
    p4h: "Past clients don't call back - they Google.", p4p: "The kitchen you did two years ago needs a bathroom now. But you never followed up, so they're getting three new quotes."
  },
  tutor: {
    p1h: "Four sessions this month. Zero invoiced.", p1p: "The parents are lovely and would pay instantly - if the invoice existed anywhere except your intentions.",
    p2h: "Student no-showed. Parent forgot. You waited.", p2p: "No reminder went to the parent, no card on file, and your cancellation policy is a sentence you said once in September.",
    p3h: "\"Did the parents sign the agreement?\"", p3p: "Midterm season starts and you're not sure which families ever returned the tutoring contract.",
    p4h: "Summer comes, students vanish, fall is a gamble.", p4p: "Nothing reminds families to rebook for September - so every autumn you rebuild your roster from scratch."
  }
};

const PERSONAS = [
  ['default', 'Everyone'], ['therapist', 'Therapists'], ['coach', 'Coaches'],
  ['stylist', 'Stylists'], ['photographer', 'Photographers'], ['trainer', 'Trainers'],
  ['contractor', 'Contractors'], ['tutor', 'Tutors'],
];

/* ---- Interactive tour ---- */
const T = {
  quiet: {
    u: "Who's gone quiet lately?",
    a: "3 clients haven't booked in 30+ days: <b>Maya R.</b> (34 days), <b>Jordan T.</b> (31 days), and <b>Sam K.</b> (30 days). Together they usually book about $640/mo. Want me to draft check-in messages? You'd approve each one before it sends."
  },
  invoice: {
    u: "Invoice Sarah for 3 sessions at $120",
    a: "Draft ready: 3 × $120 = <b>$360</b>, due in 14 days, with your standard payment link. Nothing sends until you approve it.<div class='action'>✓ Draft invoice #1043 - Sarah M. - $360 · awaiting your OK</div>"
  },
  revenue: {
    u: "How's revenue this month?",
    a: "<b>$4,280</b> collected so far this month - up 12% from this point last month. <b>$720</b> is sitting in open invoices, and one ($180) goes overdue Thursday. Want me to queue a friendly reminder?"
  },
  workflow: {
    u: "Remind clients to rebook after 45 days",
    a: "Done - I built the automation:<div class='action'>⚡ When a client hits 45 days since last booking → send your rebooking message with your booking link</div>It's live. You can pause or edit it anytime, and you'll see everything it sends."
  }
};

// Free-text handling: match intent keywords to demo answers, honest fallback otherwise
function tourAnswer(q) {
  const s = q.toLowerCase();
  if (/quiet|ghost|haven't book|hasnt book|inactive|lapsed|win.?back|miss/.test(s)) return T.quiet.a;
  if (/invoice|bill|charge|payment link|owe/.test(s)) return T.invoice.a;
  if (/revenue|income|earn|money|numbers|sales|month/.test(s)) return T.revenue.a;
  if (/remind|rebook|workflow|automat|follow.?up/.test(s)) return T.workflow.a;
  if (/book|schedule|appoint|calendar|friday|monday|tomorrow/.test(s)) return "<b>✓ Booked.</b> I put it on the calendar with a confirmation and automatic reminders (1 week, 2 days, 1 day, and 2 hours before). Want a deposit collected too?";
  if (/what can you|help|do you do|features/.test(s)) return "In the full app I work across your whole business: draft and send invoices, book sessions, chase quiet clients, build automations, answer questions from your live numbers, and more - about 30 real capabilities. Anything client-facing waits for your approval.";
  return "Great question - in the real app I'd answer that from your live business data (clients, calendar, invoices, numbers). This demo only has a small sample business, but that's exactly the kind of thing you can ask me once you're set up. Try one of the examples to see me in action!";
}

const TOUR_PROMPTS = [
  ['quiet', '"Who\'s gone quiet lately?"'],
  ['invoice', '"Invoice Sarah for 3 sessions at $120"'],
  ['revenue', '"How\'s revenue this month?"'],
  ['workflow', '"Remind clients to rebook after 45 days"'],
];

const PAGE_CSS = `
.site-root html{scroll-behavior:smooth}
.site-root .btn-dark{background:var(--ink);color:var(--lime);border:1px solid var(--border2)}
.site-root .btn-dark:hover{border-color:var(--lime)}
/* TYPE */
.site-root h1{font-size:clamp(38px,5.2vw,60px);letter-spacing:-.025em;line-height:1.08;margin-bottom:22px}
.site-root h2{font-size:clamp(30px,3.8vw,42px);letter-spacing:-.02em;line-height:1.15;margin-bottom:16px}
/* HERO */
.site-root .hero{padding:164px 0 90px;position:relative}
.site-root .hero::before{content:'';position:absolute;top:-200px;left:50%;transform:translateX(-50%);width:900px;height:600px;background:radial-gradient(ellipse,rgba(207,255,80,.09) 0%,transparent 65%);pointer-events:none}
.site-root .hero-inner{display:grid;grid-template-columns:1.05fr .95fr;gap:64px;align-items:center;position:relative}
.site-root .hero-sub{font-size:18px;color:var(--muted);max-width:520px;margin-bottom:32px}
.site-root .hero-sub strong{color:var(--text);font-weight:600}
.site-root .hero-ctas{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
/* CHAT DEMO */
.site-root .chat{background:var(--panel);border:1px solid var(--border2);border-radius:16px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.5)}
.site-root .chat-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--border);background:var(--panel2)}
.site-root .chat-head .avatar{width:28px;height:28px;border-radius:8px;background:var(--lime);display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--ink);font-weight:700}
.site-root .chat-head .name{font-weight:600;font-size:14px;font-family:var(--head)}
.site-root .chat-head .status{font-size:12px;color:var(--lime);margin-left:auto;display:flex;align-items:center;gap:6px}
.site-root .chat-head .status::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--lime)}
.site-root .chat-body{padding:20px;display:flex;flex-direction:column;gap:14px;min-height:340px}
.site-root .msg{max-width:85%;padding:11px 15px;border-radius:12px;font-size:13.5px;line-height:1.55;opacity:0;transform:translateY(8px);animation:msgIn .45s forwards}
@keyframes msgIn{to{opacity:1;transform:none}}
.site-root .msg.user{align-self:flex-end;background:var(--tint);border:1px solid rgba(207,255,80,.3);border-bottom-right-radius:4px}
.site-root .msg.ivy{align-self:flex-start;background:var(--panel2);border:1px solid var(--border);border-bottom-left-radius:4px;color:var(--muted)}
.site-root .msg.ivy b{color:var(--text);font-weight:600}
.site-root .msg .action{display:flex;align-items:center;gap:8px;margin-top:10px;padding:9px 12px;background:rgba(207,255,80,.08);border:1px solid rgba(207,255,80,.25);border-radius:8px;font-size:12.5px;color:var(--lime)}
.site-root .chat-input{display:flex;gap:10px;padding:14px 18px;border-top:1px solid var(--border);background:var(--panel2)}
.site-root .chat-input .field{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:13px;color:var(--dim)}
.site-root .chat-input .send{width:38px;height:38px;border-radius:8px;background:var(--lime);display:flex;align-items:center;justify-content:center;color:var(--ink);font-weight:700}
/* STATS BAR */
.site-root .stats{border-top:1px solid var(--border);border-bottom:1px solid var(--border);background:var(--panel)}
.site-root .stats-inner{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;padding:36px 0;text-align:center}
.site-root .stat .num{font-family:var(--head);font-size:30px;font-weight:600;letter-spacing:-.02em}
.site-root .stat .num.lime{color:var(--lime)}
.site-root .stat .lbl{font-size:13px;color:var(--dim);margin-top:2px}
/* SECTIONS */
.site-root section{padding:96px 0}
/* REPLACE GRID */
.site-root .replace-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:48px}
.site-root .replace-card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:20px;transition:.2s;text-align:left}
.site-root .replace-card:hover{border-color:var(--border2);transform:translateY(-2px)}
.site-root .replace-card .tool{font-weight:600;font-size:15px;text-decoration:line-through;text-decoration-color:rgba(248,113,113,.7);text-decoration-thickness:2px}
.site-root .replace-card .price{font-size:13px;color:var(--dim);margin-top:2px}
.site-root .replace-card .with{font-size:13px;color:var(--lime);margin-top:10px;font-weight:500}
.site-root .replace-total{margin-top:28px;display:flex;justify-content:center;gap:40px;align-items:baseline;flex-wrap:wrap}
.site-root .replace-total .old{font-size:20px;color:var(--dim);text-decoration:line-through}
.site-root .replace-total .new{font-family:var(--head);font-size:34px;font-weight:600;color:var(--lime)}
.site-root .replace-total .new small{font-size:15px;color:var(--muted);font-weight:400;font-family:Inter,sans-serif}
/* FEATURES */
.site-root .feat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:52px;text-align:left}
.site-root .feat{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:28px;transition:.25s}
.site-root .feat:hover{border-color:rgba(207,255,80,.4);background:var(--panel2)}
.site-root .feat .icon{width:42px;height:42px;border-radius:10px;background:var(--tint);border:1px solid rgba(207,255,80,.25);display:flex;align-items:center;justify-content:center;font-size:19px;margin-bottom:18px}
.site-root .feat h3{font-size:17px;margin-bottom:8px;font-weight:600}
.site-root .feat p{font-size:14px;color:var(--muted)}
/* IVY SECTION */
.site-root .ivy-grid{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center;margin-top:12px}
.site-root .ivy-list{display:flex;flex-direction:column;margin-top:36px}
.site-root .ivy-item{display:flex;gap:16px;padding:18px 0;border-bottom:1px solid var(--border)}
.site-root .ivy-item:last-child{border-bottom:none}
.site-root .ivy-item .n{font-family:var(--head);font-size:13px;color:var(--lime);padding-top:3px}
.site-root .ivy-item h4{font-size:16px;font-weight:600;margin-bottom:4px}
.site-root .ivy-item p{font-size:14px;color:var(--muted)}
.site-root .terminal{background:var(--bg);border:1px solid var(--border2);border-radius:14px;overflow:hidden;font-size:13.5px;box-shadow:0 24px 60px rgba(0,0,0,.45)}
.site-root .term-head{display:flex;gap:7px;padding:14px 16px;border-bottom:1px solid var(--border)}
.site-root .term-head span{width:11px;height:11px;border-radius:50%;background:var(--border2)}
.site-root .term-body{padding:20px;line-height:2}
.site-root .term-body .cmd{color:var(--text)}
.site-root .term-body .cmd::before{content:'you - ';color:var(--lime);font-weight:600}
.site-root .term-body .out{color:var(--muted)}
.site-root .term-body .out::before{content:'ivy - ';color:var(--dim);font-weight:600}
.site-root .term-body .ok{color:var(--lime)}
/* STEPS */
.site-root .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:52px;text-align:left}
.site-root .step{background:var(--bg);border:1px solid var(--border);border-radius:14px;padding:30px}
.site-root .step .num{font-family:var(--head);font-size:13px;color:var(--lime);margin-bottom:16px;letter-spacing:.08em}
.site-root .step h3{font-size:18px;font-weight:600;margin-bottom:8px}
.site-root .step p{font-size:14px;color:var(--muted)}
/* PRICING TEASER - lime card like live site */
.site-root .price-card{max-width:520px;margin:52px auto 0;background:var(--lime);color:var(--ink);border-radius:18px;padding:42px;text-align:left;position:relative}
.site-root .price-card .plan{font-family:var(--head);font-size:22px;font-weight:600}
.site-root .price-card .plan-sub{font-size:14px;color:rgba(11,12,8,.7);margin-bottom:18px}
.site-root .price-card .amount{font-family:var(--head);font-size:52px;font-weight:600;letter-spacing:-.02em;line-height:1.1}
.site-root .price-card .terms{font-size:13.5px;color:rgba(11,12,8,.75);margin:8px 0 4px}
.site-root .price-card .annual{font-size:13.5px;color:rgba(11,12,8,.75);margin-bottom:22px}
.site-root .price-card .annual b{color:var(--ink)}
.site-root .price-card ul{list-style:none;margin:22px 0;display:grid;gap:9px}
.site-root .price-card li{font-size:14px;color:rgba(11,12,8,.85);display:flex;gap:9px}
.site-root .price-card li::before{content:'✓';font-weight:700}
.site-root .price-card .btn{background:var(--ink);color:var(--lime);width:100%;justify-content:center;text-decoration:underline;text-underline-offset:3px}
.site-root .price-card .fine{font-size:12.5px;color:rgba(11,12,8,.65);margin-top:12px;text-align:center}
/* CTA */
.site-root .cta-final{text-align:center;position:relative}
.site-root .cta-final::before{content:'';position:absolute;bottom:-100px;left:50%;transform:translateX(-50%);width:800px;height:400px;background:radial-gradient(ellipse,rgba(207,255,80,.08) 0%,transparent 65%);pointer-events:none}
/* VERTICALS LINE */
.site-root .verticals{font-size:13.5px;color:var(--dim);margin-top:18px}
.site-root .verticals b{color:var(--muted);font-weight:500}
/* AEO ANSWER BLOCK */
.site-root .answer{background:var(--panel);border:1px solid var(--border);border-left:3px solid var(--lime);border-radius:12px;padding:26px 30px;max-width:840px;margin:0 auto}
.site-root .answer p{font-size:15.5px;color:var(--muted)}
.site-root .answer p b{color:var(--text)}
/* PAIN SECTION */
.site-root .pain-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:48px;text-align:left}
.site-root .pain{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:28px}
.site-root .pain .t{font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-bottom:12px}
.site-root .pain h3{font-size:18px;font-weight:600;margin-bottom:10px}
.site-root .pain p{font-size:14.5px;color:var(--muted);margin-bottom:14px}
.site-root .pain .fix{font-size:14px;color:var(--lime);font-weight:500;padding-top:12px;border-top:1px solid var(--border)}
/* FOUNDER NOTE */
.site-root .founder{max-width:720px;margin:0 auto;background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:40px;text-align:left}
.site-root .founder .quote{font-family:var(--head);font-size:20px;line-height:1.5;color:var(--text);margin-bottom:22px;letter-spacing:-.01em}
.site-root .founder .quote .hl{color:var(--lime)}
.site-root .founder .who{display:flex;align-items:center;gap:14px}
.site-root .founder .who .av{width:44px;height:44px;border-radius:50%;background:var(--tint);border:1px solid rgba(207,255,80,.35);display:flex;align-items:center;justify-content:center;color:var(--lime);font-weight:700;font-family:var(--head)}
.site-root .founder .who b{display:block;font-size:15px}
.site-root .founder .who span{font-size:13px;color:var(--dim)}
/* PERSONA PICKER */
.site-root .personas{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:30px}
.site-root .persona{background:var(--panel);border:1px solid var(--border2);color:var(--muted);font-family:Inter,sans-serif;font-size:13.5px;font-weight:600;padding:8px 16px;border-radius:999px;cursor:pointer;transition:.2s}
.site-root .persona:hover{border-color:var(--lime);color:var(--text)}
.site-root .persona.on{background:var(--lime);border-color:var(--lime);color:var(--ink)}
/* INTERACTIVE TOUR */
.site-root .tour-wrap{display:grid;grid-template-columns:.9fr 1.1fr;gap:44px;align-items:start;margin-top:48px;text-align:left}
.site-root .tour-prompts{display:flex;flex-direction:column;gap:10px}
.site-root .tour-prompt{background:var(--panel);border:1px solid var(--border2);color:var(--text);font-family:Inter,sans-serif;font-size:14.5px;font-weight:500;padding:15px 18px;border-radius:12px;cursor:pointer;text-align:left;transition:.2s;display:flex;gap:10px;align-items:center}
.site-root .tour-prompt:hover{border-color:var(--lime)}
.site-root .tour-prompt.used{border-color:rgba(207,255,80,.4);color:var(--dim)}
.site-root .tour-prompt .arrow{margin-left:auto;color:var(--lime)}
.site-root .tour-note{font-size:12.5px;color:var(--dim);margin-top:14px}
.site-root .tour-chat{background:var(--panel);border:1px solid var(--border2);border-radius:16px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.4)}
.site-root .tour-chat .chat-body{min-height:300px;max-height:420px;overflow-y:auto}
.site-root .msg.static{opacity:1;transform:none;animation:none}
.site-root .typing{align-self:flex-start;color:var(--dim);font-size:13px;padding:4px 2px}
@media(max-width:900px){.site-root .tour-wrap{grid-template-columns:1fr}}
/* SCROLL REVEAL */
@media (prefers-reduced-motion: no-preference){
 .site-root .reveal{opacity:0;transform:translateY(18px);transition:opacity .6s ease,transform .6s ease}
 .site-root .reveal.in{opacity:1;transform:none}
}
@media(max-width:900px){
 .site-root .hero-inner,.site-root .ivy-grid{grid-template-columns:1fr;gap:44px}
 .site-root .feat-grid,.site-root .steps{grid-template-columns:1fr 1fr}
 .site-root .replace-grid,.site-root .pain-grid{grid-template-columns:1fr 1fr}
 .site-root .stats-inner{grid-template-columns:1fr 1fr;gap:28px}
}
@media(max-width:560px){.site-root .feat-grid,.site-root .steps,.site-root .pain-grid{grid-template-columns:1fr}}
`;

export default function SiteHome() {
  useSiteFonts();
  usePageMeta({
    title: 'Ivy - All-in-One Business Platform for Solopreneurs | Booking, Invoicing, CRM & AI',
    description: 'Ivy is the all-in-one business platform for solo service businesses - therapists, coaches, stylists, photographers, trainers, contractors, and tutors. Booking, invoicing, CRM, e-signature, website builder, and an AI assistant that does your busywork. $8.99/week, no transaction fees, 14-day free trial.',
    canonical: 'https://joinivy.ai/',
    ogType: 'website',
    jsonLd: JSON_LD,
  });

  const rootRef = useRef(null);

  /* ---- Count-up stats (trigger once, on scroll into view) ---- */
  useEffect(() => {
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    function animateNum(el) {
      const start = parseFloat(el.dataset.start), end = parseFloat(el.dataset.end);
      const dec = +(el.dataset.decimals || 0);
      const pre = el.dataset.prefix || '', suf = el.dataset.suffix || '';
      const final = el.dataset.final;
      if (reduceMotion) { el.textContent = final; return; }
      const dur = 1300, t0 = performance.now();
      function frame(t) {
        const p = Math.min(1, (t - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
        const val = start + (end - start) * eased;
        el.textContent = pre + val.toFixed(dec) + suf;
        if (p < 1) requestAnimationFrame(frame);
        else el.textContent = final;
      }
      requestAnimationFrame(frame);
    }
    const statNums = rootRef.current.querySelectorAll('.stat .num[data-end]');
    const statObs = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) { animateNum(e.target); statObs.unobserve(e.target); }
      });
    }, { threshold: 0.5 });
    statNums.forEach(el => statObs.observe(el));
    return () => statObs.disconnect();
  }, []);

  /* ---- Scroll reveal for cards (staggered fade-up) ---- */
  useEffect(() => {
    const revealEls = rootRef.current.querySelectorAll('.pain, .feat, .step, .replace-card, .ivy-item, .founder');
    revealEls.forEach(el => el.classList.add('reveal'));
    const revObs = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        const el = e.target;
        const siblings = [...el.parentElement.children].filter(c => c.classList.contains('reveal'));
        el.style.transitionDelay = (siblings.indexOf(el) % 4) * 90 + 'ms';
        el.classList.add('in');
        revObs.unobserve(el);
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
    revealEls.forEach(el => revObs.observe(el));
    return () => revObs.disconnect();
  }, []);

  /* ---- Persona picker state ---- */
  const [persona, setPersona] = useState('default');
  const d = P[persona];

  /* ---- Interactive tour state ---- */
  const [messages, setMessages] = useState([]);
  const [typing, setTyping] = useState(false);
  const [used, setUsed] = useState([]);
  const [tourInput, setTourInput] = useState('');
  const tourBodyRef = useRef(null);
  const timersRef = useRef([]);

  useEffect(() => () => timersRef.current.forEach(clearTimeout), []);

  useEffect(() => {
    const el = tourBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typing]);

  function tourReply(userText, replyHtml) {
    setMessages(m => [...m, { who: 'user', text: userText }]);
    setTyping(true);
    timersRef.current.push(setTimeout(() => {
      setTyping(false);
      setMessages(m => [...m, { who: 'ivy', html: replyHtml }]);
    }, 700));
  }

  function onPrompt(key) {
    const t = T[key]; if (!t) return;
    setUsed(u => (u.includes(key) ? u : [...u, key]));
    tourReply(t.u, t.a);
  }

  function tourSubmit() {
    const q = tourInput.trim();
    if (!q) return;
    setTourInput('');
    tourReply(q, tourAnswer(q));
  }

  return (
    <div className="site-root" ref={rootRef}>
      <style>{BASE_CSS + PAGE_CSS}</style>
      <SiteNav active="/" />

      <header className="hero">
        <div className="container hero-inner">
          <div>
            <span className="eyebrow">All-in-one, for solopreneurs</span>
            <h1>The business platform with an AI that <em className="lime" style={{ fontStyle: 'normal' }}>does</em> the work.</h1>
            <p className="hero-sub">Meet Ivy. She knows your clients, your numbers, and your calendar - and she actually <strong>does your busywork</strong>: invoicing, booking, follow-ups, contracts, and more. One workspace, <strong>no transaction fees</strong>.</p>
            <div className="hero-ctas">
              <a href="/signup" className="btn btn-primary">Start your 14-day free trial</a>
              <a href="/tour" className="btn btn-ghost">Take the tour</a>
            </div>
            <p className="trust">$0 today · Cancel anytime · Your money goes straight to your Stripe - we never touch it</p>
            <p className="verticals">Built for <b>therapists</b>, <b>coaches</b>, <b>stylists</b>, <b>photographers</b>, <b>personal trainers</b>, <b>contractors</b>, <b>tutors</b> - and every other business of one.</p>
          </div>
          <div className="chat">
            <div className="chat-head">
              <div className="avatar">✓</div>
              <div className="name">Ivy</div>
              <div className="status">online</div>
            </div>
            <div className="chat-body">
              <div className="msg user" style={{ animationDelay: '.3s' }}>Who's gone quiet lately?</div>
              <div className="msg ivy" style={{ animationDelay: '1s' }}><b>Sarah</b> is 22 days quiet, and <b>Jordan</b> and <b>Maya</b> haven't booked in 30+ days. Want me to send Sarah a check-in?</div>
              <div className="msg user" style={{ animationDelay: '1.9s' }}>Yes - and include my booking link</div>
              <div className="msg ivy" style={{ animationDelay: '2.7s' }}>Draft ready for your approval:
                <div className="action">✓ check-in → Sarah + booking link</div>
                <div className="action">✓ drafts queued → Jordan, Maya</div>
              </div>
            </div>
            <div className="chat-input">
              <div className="field">Ask Ivy anything…</div>
              <div className="send">↑</div>
            </div>
          </div>
        </div>
      </header>

      <div className="stats">
        <div className="container stats-inner">
          <div className="stat"><div className="num lime" data-start="2.9" data-end="0" data-decimals="1" data-suffix="%" data-final="0%">0%</div><div className="lbl">transaction fees, forever</div></div>
          <div className="stat"><div className="num" data-start="0" data-end="100" data-prefix="$" data-suffix="+" data-final="$100+">$100+</div><div className="lbl">average monthly savings</div></div>
          <div className="stat"><div className="num" data-start="0" data-end="8" data-suffix=" tools" data-final="8 tools">8 tools</div><div className="lbl">replaced with one login</div></div>
          <div className="stat"><div className="num" data-start="0" data-end="14" data-suffix=" days" data-final="14 days">14 days</div><div className="lbl">free trial, $0 today</div></div>
        </div>
      </div>

      <section style={{ padding: '56px 0 0' }}>
        <div className="container">
          <div className="answer">
            <p><b>What is Ivy?</b> Ivy (joinivy.ai) is an all-in-one business platform for solopreneurs - solo service-business owners like therapists, coaches, stylists, photographers, personal trainers, contractors, and tutors. It combines online booking, invoicing, client CRM, e-signature, two-way messaging, email campaigns, and a website builder with an AI assistant that performs real tasks on your behalf. Ivy costs $8.99/week after a 14-day free trial (or $375/year) and charges no transaction fees - payments go directly to your own Stripe account.</p>
          </div>
        </div>
      </section>

      <section>
        <div className="container center">
          <span className="eyebrow">Sound familiar?</span>
          <h2>It's 11pm and you're still doing admin.</h2>
          <p className="section-sub">You didn't start your business to become a part-time software administrator. But somewhere between the booking app, the invoice app, and the texts, that's what happened.</p>
          <div className="personas">
            {PERSONAS.map(([key, label]) => (
              <button
                key={key}
                className={`persona${persona === key ? ' on' : ''}`}
                onClick={() => setPersona(key)}
              >{label}</button>
            ))}
          </div>
          <div className="pain-grid">
            <div className="pain">
              <div className="t">The invoice you keep meaning to send</div>
              <h3>{d.p1h}</h3>
              <p>{d.p1p}</p>
              <div className="fix">→ Ivy drafts it the moment the session completes. You tap send.</div>
            </div>
            <div className="pain">
              <div className="t">The no-show that cost you real money</div>
              <h3>{d.p2h}</h3>
              <p>{d.p2p}</p>
              <div className="fix">→ Card on file + automatic email and SMS reminders. Your policy enforces itself.</div>
            </div>
            <div className="pain">
              <div className="t">The paperwork hunt</div>
              <h3>{d.p3h}</h3>
              <p>{d.p3p}</p>
              <div className="fix">→ Forms and waivers auto-send at booking and attach to the client - signed, stamped, findable.</div>
            </div>
            <div className="pain">
              <div className="t">The client who quietly disappeared</div>
              <h3>{d.p4h}</h3>
              <p>{d.p4p}</p>
              <div className="fix">→ Ivy watches. "Sarah's 22 days quiet - want me to send a check-in?"</div>
            </div>
          </div>
        </div>
      </section>

      <section className="alt">
        <div className="container center">
          <span className="eyebrow">One price. Every tool you'd otherwise piece together.</span>
          <h2>You're probably spending $150/month or more on stitched-together tools.</h2>
          <p className="section-sub">On average, solo businesses spend $150/month - or even more - running tools like these in parallel. Ivy does each of them, then makes them talk to each other, so booking → invoice → message → follow-up is one fluid motion.</p>
          <div className="replace-grid">
            <div className="replace-card"><div className="tool">HoneyBook</div><div className="price">$39/mo</div><div className="with">clients + invoices + contracts</div></div>
            <div className="replace-card"><div className="tool">Calendly</div><div className="price">$12/mo</div><div className="with">booking pages + reminders</div></div>
            <div className="replace-card"><div className="tool">Acuity Scheduling</div><div className="price">$16/mo</div><div className="with">advanced scheduling + intake forms</div></div>
            <div className="replace-card"><div className="tool">QuickBooks Self-Employed</div><div className="price">$20/mo</div><div className="with">invoices + expenses + taxes</div></div>
            <div className="replace-card"><div className="tool">Mailchimp</div><div className="price">$13/mo</div><div className="with">newsletter + email blasts</div></div>
            <div className="replace-card"><div className="tool">Squarespace</div><div className="price">$23/mo</div><div className="with">website + custom domain</div></div>
            <div className="replace-card"><div className="tool">DocuSign</div><div className="price">$15/mo</div><div className="with">legally-binding e-signatures</div></div>
            <div className="replace-card"><div className="tool">Loom</div><div className="price">$15/mo</div><div className="with">product walkthroughs</div></div>
          </div>
          <div className="replace-total">
            <span className="old">$150+/mo on average</span>
            <span className="new">$8.99<small>/week · no transaction fees</small></span>
          </div>
          <p style={{ marginTop: '20px', fontSize: '14px' }}><a href="/compare" className="lime" style={{ textDecoration: 'underline', textUnderlineOffset: '3px' }}>See how Ivy compares to HoneyBook, Calendly, and the DIY stack →</a></p>
        </div>
      </section>

      <section>
        <div className="container">
          <span className="eyebrow">Meet Ivy</span>
          <h2>AI that does the work, not a chatbot.</h2>
          <div className="ivy-grid">
            <div>
              <p className="section-sub">Ivy sees your real numbers - revenue this month, active clients, who's gone quiet, what's overdue - and answers in plain English with specific actions. Not "consider engaging your top customers" but "send Sarah a check-in; she's 22 days quiet."</p>
              <div className="ivy-list">
                <div className="ivy-item"><span className="n">01</span><div><h4>Knows your business</h4><p>"How's revenue this month?" "Who's overdue?" "What's on Thursday?" Instant answers from your live data - and only yours.</p></div></div>
                <div className="ivy-item"><span className="n">02</span><div><h4>Has tools, uses them</h4><p>Tell her to draft a thank-you to a client who just paid and send it through the portal - she'll do all of it.</p></div></div>
                <div className="ivy-item"><span className="n">03</span><div><h4>Quietly nudges</h4><p>"Sarah hasn't booked in three weeks; want me to send a check-in?" Ivy surfaces lost revenue before it's lost.</p></div></div>
                <div className="ivy-item"><span className="n">04</span><div><h4>Asks before it sends</h4><p>Anything that reaches a client - messages, invoices, contracts - waits for your one-tap approval.</p></div></div>
              </div>
            </div>
            <div className="terminal">
              <div className="term-head"><span></span><span></span><span></span></div>
              <div className="term-body">
                <div className="cmd">invoice Sarah for 3 sessions at $120</div>
                <div className="out">Draft created - 3 × $120 = $360, due in 14 days. <span className="ok">Send it?</span></div>
                <div className="cmd">yes, and remind her if it goes overdue</div>
                <div className="out"><span className="ok">✓ Invoice sent.</span> Overdue reminders are already automatic - I'll nudge you both if it slips.</div>
                <div className="cmd">book Marcus for Friday 2pm</div>
                <div className="out"><span className="ok">✓ Booked.</span> Confirmation and reminders are scheduled.</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="alt" id="tour">
        <div className="container center">
          <span className="eyebrow">Try Ivy right now</span>
          <h2>Don't take our word for it. Ask.</h2>
          <p className="section-sub">Type anything, or grab an example below - no signup, no email, no sales call. In the real app, Ivy answers from your live business data.</p>
          <div className="tour-wrap">
            <div>
              <p style={{ fontSize: '12px', fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--dim)', marginBottom: '10px', textAlign: 'left' }}>Some ideas to start</p>
              <div className="tour-prompts">
                {TOUR_PROMPTS.map(([key, label]) => (
                  <button
                    key={key}
                    className={`tour-prompt${used.includes(key) ? ' used' : ''}`}
                    onClick={() => onPrompt(key)}
                  >{label}<span className="arrow">→</span></button>
                ))}
              </div>
              <p className="tour-note">These are just examples - in the real Ivy you type whatever you need, and she works on your actual data. This demo runs on a sample business. Anything that reaches a client always waits for your approval.</p>
            </div>
            <div className="tour-chat">
              <div className="chat-head">
                <div className="avatar">✓</div>
                <div className="name">Ivy</div>
                <div className="status">online</div>
              </div>
              <div className="chat-body" ref={tourBodyRef}>
                <div className="msg ivy static">Hi! I'm Ivy. Ask me anything about running the sample business - or grab an example on the left.</div>
                {messages.map((m, i) => (
                  m.who === 'user'
                    ? <div key={i} className="msg user static">{m.text}</div>
                    : <div key={i} className="msg ivy static" dangerouslySetInnerHTML={{ __html: m.html }} />
                ))}
                {typing && <div className="typing">Ivy is typing…</div>}
              </div>
              <div className="chat-input">
                <input
                  className="field"
                  type="text"
                  placeholder="Ask Ivy anything…"
                  aria-label="Ask Ivy"
                  style={{ fontFamily: 'Inter,sans-serif', color: 'var(--text)', outline: 'none' }}
                  value={tourInput}
                  onChange={e => setTourInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') tourSubmit(); }}
                />
                <button className="send" aria-label="Send" style={{ border: 'none', cursor: 'pointer' }} onClick={tourSubmit}>↑</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="container center">
          <span className="eyebrow">Everything included</span>
          <h2>One login. The whole business.</h2>
          <p className="section-sub">Every feature ships in the one plan. No tiers, no add-ons, no per-seat math.</p>
          <div className="feat-grid">
            <div className="feat"><div className="icon">📅</div><h3>Online booking + calendar sync</h3><p>A public booking page clients use without logging in - services, packages, deposits, and automatic email + SMS reminders.</p></div>
            <div className="feat"><div className="icon">🧾</div><h3>Branded invoices + recurring billing</h3><p>Invoices, quotes, card on file + auto-charges, and public pay links - straight to your Stripe with no transaction fees.</p></div>
            <div className="feat"><div className="icon">👥</div><h3>Unlimited clients + pipeline</h3><p>Every client's bookings, invoices, documents, notes, and messages in one place. Import from CSV in minutes.</p></div>
            <div className="feat"><div className="icon">✍️</div><h3>Documents + e-signature</h3><p>Waivers, intakes, and agreements - built from templates or your own PDFs, auto-sent on booking, legally binding.</p></div>
            <div className="feat"><div className="icon">💬</div><h3>Two-way client messaging</h3><p>Direct and group threads with photos, voice memos, and auto-transcription. Replies land in your clients' free portal.</p></div>
            <div className="feat"><div className="icon">🌐</div><h3>Website builder + custom domain</h3><p>Drag-and-drop pages published to your own domain, SEO built in. Site forms turn visitors into leads automatically.</p></div>
            <div className="feat"><div className="icon">⚡</div><h3>Workflows + automated reminders</h3><p>"When a booking completes, wait 2 days, then ask for a review." Describe the rule - Ivy builds the workflow.</p></div>
            <div className="feat"><div className="icon">💳</div><h3>Memberships, packages & gift cards</h3><p>Recurring revenue built in - plus in-person sales with Tap to Pay on iPhone/Android, and reviews + rewards.</p></div>
            <div className="feat"><div className="icon">📊</div><h3>Goals + finance dashboard</h3><p>Revenue, expenses, time tracking, and a Schedule-C-ready tax export compatible with QuickBooks and Xero.</p></div>
          </div>
        </div>
      </section>

      <section className="alt">
        <div className="container center">
          <span className="eyebrow">Getting started</span>
          <h2>Just a few minutes to set up.</h2>
          <div className="steps">
            <div className="step"><div className="num">STEP 01</div><h3>Set up in minutes</h3><p>Guided onboarding walks you through services, availability, branding, and connecting your Stripe. Save and resume anytime.</p></div>
            <div className="step"><div className="num">STEP 02</div><h3>Share one link</h3><p>Your booking page and website go live instantly. Clients book, pay deposits, fill intake forms, and sign - in one flow.</p></div>
            <div className="step"><div className="num">STEP 03</div><h3>Let Ivy work</h3><p>Reminders, follow-ups, overdue nudges, and review requests run on autopilot. Ask Ivy for anything else.</p></div>
          </div>
        </div>
      </section>

      <section>
        <div className="container center">
          <span className="eyebrow">Simple pricing</span>
          <h2>No transaction fees, no per-seat math.</h2>
          <div className="price-card">
            <div className="plan">Ivy</div>
            <div className="plan-sub">Everything to run your business, in one place.</div>
            <div className="amount">14 days free</div>
            <p className="terms">then $8.99 / week once you subscribe. No per-seat math, no transaction fees.</p>
            <p className="annual">Or save with annual - <b>$375/yr</b> (save about 20%).</p>
            <ul>
              <li>Unlimited clients + pipeline</li>
              <li>Ivy AI assistant (chat + actions, personalized to you)</li>
              <li>Stripe payments (no transaction fee)</li>
              <li>Free client portal - forever</li>
            </ul>
            <a href="/signup" className="btn">Start your 14-day free trial →</a>
            <p className="fine">$0 today · Cancel anytime</p>
          </div>
          <p style={{ marginTop: '22px', fontSize: '14px' }}><a href="/pricing" className="lime">See full pricing + ROI calculator →</a></p>
        </div>
      </section>

      <section className="alt">
        <div className="container">
          <div className="founder">
            <p className="quote">"I built Ivy because I ran my business the duct-tape way - five apps, five bills, and invoices I sent at 11pm. <span className="hl">Software for businesses of one shouldn't feel like a second job.</span> I answer the support inbox personally, and every reply lands with me."</p>
            <div className="who">
              <div className="av">K</div>
              <div><b>Kayla</b><span>Founder, Ivy · joinivy.ai</span></div>
            </div>
          </div>
        </div>
      </section>

      <section className="cta-final">
        <div className="container">
          <span className="eyebrow">Try it</span>
          <h2>Bring one client in.<br />See if it feels <span className="lime">different</span>.</h2>
          <p className="section-sub" style={{ margin: '0 auto 34px' }}>14 days free, $0 today, just a few minutes to set up - at joinivy.ai.</p>
          <a href="/signup" className="btn btn-primary">Start your 14-day free trial</a>
          <p className="trust" style={{ marginTop: '14px' }}>$0 today · Cancel anytime</p>
        </div>
      </section>

      <SiteFooter />
      <StickyCta />
    </div>
  );
}
