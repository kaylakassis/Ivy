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
We believe anyone should be able to run a real business on their own. We build the software that makes that possible.

Running a business by yourself means being the owner, the scheduler, the bookkeeper and the support team, 24/7. Ivy puts all of it in one place, and gives you an assistant that does the work alongside you.

BOOKINGS
Share a booking link or your own site and let clients book themselves. Set your hours, buffers, deposits and booking notice once, and reminders go out on their own. Connect Google Calendar so your personal commitments block out automatically. Sell packages and memberships for sessions bought in advance.

CLIENTS
Every client in one record: their history, notes, photos, documents and messages. No more scrolling back through your texts to remember what you quoted. Import your list from a spreadsheet, and send intake forms clients fill in from their phone.

INVOICES AND PAYMENTS
Send an invoice in seconds and get paid through your own Stripe, Square or PayPal account at their standard rates. Set up recurring invoices for retainers and collect deposits up front. Ivy stays on top of reminding clients about late payments so you do not have to.

CONTRACTS AND DOCUMENTS
Send a contract, get it signed. E-signatures are built in, with reusable templates for waivers, intake forms, agreements and NDAs, several signers in order (including you), and automatic reminders for anything still unsigned. Everyone gets the signed PDF, and it stays attached to the client's record.

YOUR OWN WEBSITE
A booking site with your services, prices and photos, live on your own custom domain. Sell products, packages and gift cards straight from it.

MESSAGING
One inbox for every client conversation, so nothing gets lost between your texts, your email and your DMs. Text messages too, when you connect your business number.

GROWTH
Email campaigns to your clients. Review requests sent at the right moment. Loyalty rewards for the regulars and a referral program with tracked codes. Workflows that send the follow-up, the reminder or the thank-you for you, triggered by what happens in your business.

THE MONEY SIDE
Track expenses, see your profit and loss, set goals and log your time. A dashboard with revenue, unpaid invoices and today's schedule. Export everything whenever you want, because it is your data, and lock the app with Face ID.

IVY, YOUR ASSISTANT
Ask Ivy to book a client, send an invoice, chase the overdue ones, draft a message or tell you how the month is going. Upload a spreadsheet or PDF and Ivy pulls out the takeaways. It knows your business, remembers what you tell it, and flags what needs you before it turns into a problem.

A FREE PORTAL FOR YOUR CLIENTS
Your clients get their own place to see bookings, invoices, documents and messages, at no cost to them or you.

WHO IT IS FOR
Ivy is built for people who run the whole business themselves. Stylists, cleaners, trainers, coaches, photographers, consultants, contractors, and anyone else who IS the entire company.

TRY IT FREE
Every account starts with a 14 day free trial. Nothing is charged until it ends, and you can cancel anytime.

SUBSCRIPTION DETAILS
Ivy Weekly: $8.99 per week
Ivy Annual: $374.99 per year, about $7.19 per week

Payment is charged to your Apple ID at confirmation of purchase. Subscriptions renew automatically unless auto renew is turned off at least 24 hours before the end of the current period. You can manage or cancel your subscription in your Apple ID settings.

Terms of Use: https://www.joinivy.ai/terms
Privacy Policy: https://www.joinivy.ai/privacy
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
