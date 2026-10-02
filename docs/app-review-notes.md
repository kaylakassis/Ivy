# App Review notes (paste into App Store Connect → App Review Information → Notes, and into the reply)

## 2. Purpose and audience

Ivy is a business platform for solo service providers: coaches, consultants, photographers, trainers, tutors, stylists and other one-person businesses. It replaces the five or six separate tools they usually pay for (booking, invoicing, client records, e-signature, messaging, website) with one app, and adds Ivy, an AI assistant that does the admin work on request: it drafts and sends invoices, books sessions, writes client messages, builds the owner's website and sets up automations. Anything that reaches a client needs the owner's approval first. The value is time: an owner stops doing admin in the evenings and gets paid faster.

There are two kinds of users. Business owners run their business in the app. Their clients get a free portal (same app, "Client" mode) to book, pay invoices, sign documents and message the business.

## 3. Setup and access

Demo owner account (full access, no payment needed):
- Email: `DEMO_OWNER_EMAIL`
- Password: `DEMO_OWNER_PASSWORD`

Demo client account (the portal side):
- Email: `DEMO_CLIENT_EMAIL`
- Password: `DEMO_CLIENT_PASSWORD`

Typical flow: open the app → Sign in → Dashboard. Clients (add or open a client), Calendar (book a session), Finance (create and send an invoice), Messages (two-way chat with a client), Documents (send a form for signature), Website (build and publish the public site), Ivy (ask the assistant to do any of the above). Account → Delete my account removes the account and its data.

No sample files are needed. Photo and file uploads are optional everywhere.

## 1. What the recording shows

Launch → Create account → onboarding → subscription screen (title, weekly and annual price and length, Terms of Use and Privacy Policy links) → Dashboard → add a client → send a message → report and block a contact from the message menu → Account → Blocked and Reports → Account → Delete my account. Then sign in as the demo client and show the portal: messages, report and block a business, Profile → Blocked and Reports.

## User-generated content

Users write to each other in Messages (owner ↔ client, and group chats a business runs). Both sides can report a message or a person (reason + details) and block the other party. Reports are reviewed by the operator within 24 hours in the admin console, and a blocked party cannot send or receive messages with the blocker. Blocked and Reports lists are in Account (owners) and Profile (clients). Client reviews of a business are moderated by the business and can be appealed to the operator.

## 4. External services

- Apple In-App Purchase through RevenueCat (subscriptions on iOS)
- Stripe (owner subscription on the web; and Stripe Connect so owners take card payments from their own clients into their own Stripe account)
- Resend (transactional email), Twilio (SMS reminders and two-way texting), Apple Push Notification service and Web Push
- Vercel (hosting and file storage), Neon Postgres (database), Sentry (crash reporting)
- An AI model provider for the Ivy assistant (large language model API). Ivy only sees the signed-in user's own workspace data.
- Jitsi (video rooms for virtual sessions)

## 5. Regional differences

None. The app functions the same in every region. Prices are shown in USD.

## 6. Regulated industry / third-party material

Not applicable. Ivy is general business software and contains no licensed third-party content.

## 7. In-App Purchases

One auto-renewing subscription, "Ivy", in two lengths: weekly ($8.99 per week) and annual ($374.99 per year), each with a 14-day free trial. It unlocks the business side of the app (clients, bookings, invoicing, documents, website, messaging, the Ivy assistant). The client portal is free and never requires a purchase.

How to reach it: create an owner account → complete onboarding → the subscription screen appears before the dashboard (or Account → Subscription at any time). The screen shows the plan name, length, price, trial, Restore Purchases, and links to the Terms of Use and Privacy Policy.
