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
Ivy is the all-in-one business platform for people who run a business of one: coaches, trainers, stylists, massage therapists, photographers, tutors, contractors and consultants. Clients, booking, invoices, contracts, messages, marketing and your own website, in one app on your phone, with an AI assistant that knows your numbers.

CLIENTS
Every person you work with, in one place.
- Client list with history, notes and payments
- Import existing clients from a spreadsheet
- Intake forms clients fill in from their phone
- Leads and active clients kept separate
- See who has gone quiet before they churn

BOOKING AND CALENDAR
Let clients book you without the back-and-forth.
- Your own booking link with your real availability
- Services with lengths, prices and buffers
- Deposits collected at booking
- Recurring appointments
- Automatic reminders so fewer people forget
- Packages and memberships for sessions bought in advance
- Two-way sync with Google Calendar

INVOICES AND PAYMENTS
Get paid faster, on your own terms.
- Send an invoice in seconds, paid by card
- Deposits and partial payments
- Recurring invoices
- Automatic overdue reminders
- Gift cards clients can buy and redeem
- Payments through your own Stripe, Square or PayPal account, straight to your bank
- Ivy takes no cut of your sales

DOCUMENTS AND SIGNATURES
Contracts and waivers signed on a phone.
- Ready-to-use templates for waivers, intake forms, agreements and NDAs
- Write your own or upload a PDF and place the fields
- Clients sign from their email, no account needed
- Several signers in order, including you
- Everyone receives the signed PDF with a signing record

MESSAGES
One inbox for every client conversation.
- Chat with clients in the app
- Text messages when you connect your business number
- Booking, invoice and document updates land in the same thread

YOUR WEBSITE
A professional site, live in minutes.
- Pages and sections you edit in place
- Services, hours and prices that stay in step with your booking page
- Use your own domain

MARKETING THAT RUNS ITSELF
- Email campaigns to your clients
- Review requests sent at the right moment
- Loyalty rewards for repeat clients
- A referral program with tracked codes
- Workflows: automatic follow-ups, reminders and tasks triggered by what happens in your business

MONEY AND GOALS
Know where you stand without a spreadsheet.
- Dashboard with revenue, outstanding invoices and today's schedule
- Expense tracking and a profit and loss summary
- Goals with progress, and tasks for the week

IVY, YOUR AI ASSISTANT
Ask a plain question and get an answer from your real data.
- Where is my money coming from this month?
- Which clients are at risk of churning?
- Am I ready to raise my rates?
- Drafts client messages and follow-ups for you
- Upload a spreadsheet or PDF and Ivy pulls out the takeaways
- A short briefing each morning with what needs your attention

A FREE CLIENT PORTAL
Your clients get their own place to see bookings, invoices, documents and messages, at no cost to them or you.

BUILT FOR ONE PERSON
- Face ID lock and two-factor sign-in
- Export everything you own at any time, and delete your account from inside the app
- No per-seat pricing and no annual contract

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
