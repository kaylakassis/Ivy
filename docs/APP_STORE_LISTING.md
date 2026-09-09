# App Store listing copy

Paste-ready text for App Store Connect → Distribution → iOS App 1.0.
Character limits are Apple's; the counts in brackets are what these
actually use. Nothing here claims a feature Ivy does not have.

Programs is deliberately absent: it is behind a preview password and not
shipping in 1.0. Do not advertise it until it is live.

---

## Name (30 max)

```
Ivy: For Solo Businesses
```
[24]

## Subtitle (30 max)

```
Bookings, invoices & clients
```
[28]

## Promotional text (170 max, editable any time without review)

```
Stop paying for six tools that barely talk to each other. Bookings, invoices, contracts and your own booking site, with an AI assistant that does the busywork.
```
[157]

## Description (4000 max)

Apple guideline 3.1.2 requires the subscription length, price and the
Terms and Privacy links in the description. They are the last block -
do not delete them.

```
Ivy is the all-in-one app for running a business of one.

If you are a massage therapist, coach, stylist, photographer, personal trainer, contractor or tutor, you did not start your business to spend evenings chasing invoices and rescheduling clients. Ivy puts the whole operation in one place, on your phone.

WHAT YOU GET

Clients. Every person you work with, their history, notes and payments in one list. Import your existing clients from a spreadsheet.

Booking. Share a booking link and let clients pick from your real availability. Reminders go out automatically, so fewer people forget.

Invoices. Send an invoice in seconds and get paid by card. Payments run through your own Stripe account and land in your bank, and Ivy never takes a cut of your sales.

Documents and signatures. Send a contract or intake form, get it signed on a phone, and keep the signed copy attached to the client.

Messaging. One inbox for client conversations, so work does not get lost between text messages and email.

Your own website. A booking site with your services, hours and prices, live in minutes, with your own domain if you want one.

Marketing that runs itself. Email campaigns, review requests, referral rewards and follow-ups that send while you work.

Ivy, your AI assistant. Ask a plain question, like which clients have gone quiet or whether you can afford to raise your rates, and get an answer based on your real numbers. Ivy can draft the follow-up message too.

A free client portal. Your clients get their own place to see bookings, invoices and documents, at no cost to them or you.

WHY SOLO OWNERS SWITCH

One subscription instead of five. Most solo owners run about $138 a month across separate tools for scheduling, invoicing, contracts, email and a website. Ivy replaces that stack.

No transaction fees from Ivy. Your processor charges its standard card rate; Ivy adds nothing on top.

No per-seat pricing and no annual contract. Cancel whenever you like.

Your data stays yours. Export everything at any time, and delete your account from inside the app.

PRICING

Start with a 14-day free trial. No card is charged today. After the trial, Ivy is $8.99 per week, or $374.99 per year to save about 20%. A subscription unlocks the entire app; there are no add-ons or upgrade tiers.

Subscriptions renew automatically unless turned off at least 24 hours before the period ends. Manage or cancel in your Apple ID settings after purchase.

Terms of Service: https://www.joinivy.ai/terms
Privacy Policy: https://www.joinivy.ai/privacy

Questions? Email support@joinivy.ai and a person answers, usually within one business day.
```

## Keywords (100 max, commas, no spaces after commas)

```
invoice,booking,scheduling,crm,client,appointment,contract,esignature,freelance,selfemployed,solo
```
[99]

Deliberately excludes competitor names. Apple rejects those, and it is
another brand's trademark. Do not add "Ivy" or words already in the app
name or subtitle; Apple indexes those separately, so repeating them
wastes characters.

## URLs

| Field | Value |
|---|---|
| Support URL | `https://www.joinivy.ai/support` |
| Marketing URL | `https://www.joinivy.ai` |
| Privacy Policy URL | `https://www.joinivy.ai/privacy` |

## Category

Primary **Business**, secondary **Productivity**.

## Age rating

4+. Ivy has no objectionable content and no user-generated content shown
to strangers. Answer "None" to every content question. Say **no** to
unrestricted web access: the app opens only its own pages.

---

## Screenshots

Six or seven, at 6.5 inch (1290 x 2796 from an iPhone 16 Pro is accepted).
Apple shows the first three on the install sheet, so lead with the
strongest. Take them on the device after a `npm run ios:sync` build, with
sample data loaded so nothing is empty:

1. Dashboard with real-looking numbers
2. Calendar, week view with bookings
3. An invoice, showing the Pay button
4. Ivy answering a question about the business
5. Documents, a contract with a signature
6. The booking site a client sees
7. Clients list

Avoid: empty states, placeholder text, a visible battery at 3%, and any
real client's name or email.

---

## App Privacy questionnaire

Answer honestly; Apple checks this against behaviour. Ivy collects the
following, all **linked to the user's identity** and **not used for
tracking** (Ivy runs no ad networks and shares nothing with data brokers):

| Data type | Why |
|---|---|
| Contact info (name, email, phone) | account, and the client records an owner enters |
| User content (documents, photos, messages) | the business data the owner stores |
| Identifiers (user ID) | to sign the owner in |
| Usage data | product analytics on the owner's own workspace |
| Diagnostics | crash reporting |
| Purchases | subscription status |

Say **no** to "Used for Tracking" for every category.

Financial data: Ivy does **not** collect card numbers. Payments are
handled by Stripe, PayPal or Square in their own checkout, so card data
never reaches Ivy's servers. Declare Payment Info as **not collected**.

---

## App Review notes

```
Sign in with the demo account below; it has sample clients, bookings and invoices already loaded.

Email: [create a demo account and put it here]
Password: [password]

The subscription paywall appears when a workspace's 14-day trial ends. To see it immediately on the demo account, open Dashboard and add ?previewPaywall=1 to the URL.

Payments to businesses are processed by Stripe in an external checkout; Ivy's own subscription is sold only through Apple In-App Purchase.
```

Create that demo account before submitting, and leave it working: an
account that does not sign in is the most common reason for a rejection.
