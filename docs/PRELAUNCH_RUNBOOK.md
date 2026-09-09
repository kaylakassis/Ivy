# Ivy — Pre-launch operator runbook

Step-by-step for the dashboard/portal tasks that *only you can do* — the
code-side scaling cliffs are already closed (commit `044bdfa`). After
each task, hit **Admin → Readiness** in the app to confirm the relevant
check turns green.

Estimated time end-to-end: **45–75 minutes**, mostly Stripe + App Store.

---

## 1. Verify `DATABASE_URL` is the Neon **pooler** endpoint (2 min)

**Why:** Vercel serverless can spawn hundreds of concurrent function
invocations. The direct Neon host caps at ~100 DB connections. The
`-pooler` host multiplexes those across a pool and is the only safe
choice under any real load.

**Steps:**

1. Open **Vercel** → your project → **Settings** → **Environment Variables**.
2. Find `DATABASE_URL`. Click the eye icon to reveal the value.
3. Look at the host portion (between `@` and `/`). One of:
   - **Good (pooler):** `ep-foo-bar-1234-pooler.us-east-2.aws.neon.tech`
   - **Bad (direct):** `ep-foo-bar-1234.us-east-2.aws.neon.tech` — no `-pooler`.
4. If it's the direct host:
   - Open **Neon dashboard** → your project → **Dashboard** tab.
   - In the connection-string panel, toggle **"Pooled connection"** ON.
   - Copy the new connection string.
   - Back in Vercel, **Edit** `DATABASE_URL`, paste the new value, **Save**.
   - **Redeploy** (env-var changes take effect on the next deploy).

**Verify:** After the deploy, open Vercel → Logs → Functions. Search for
`[db] DATABASE_URL points at a NON-POOLER`. **No matches = you're good.**

---

## 2. Stripe **Connect** webhook — `STRIPE_WEBHOOK_SECRET` (10 min)

**Why:** When end-customers pay your business owners via their connected
Stripe accounts, Stripe pings `/api/webhooks/stripe`. Without this
signing secret, every payment-success webhook is rejected — invoices
never auto-mark-paid.

**Steps:**

1. Open **Stripe Dashboard** → **Developers** → **Webhooks**.
2. Click **"+ Add endpoint"**.
3. Fill in:
   - **Endpoint URL:** `https://joinivy.ai/api/webhooks/stripe`
   - **Description:** `Ivy Connect — client payments`
   - **Events to send:** click "Select events" and check:
     - `charge.succeeded`
     - `charge.refunded`
     - `payment_intent.succeeded`
4. **Critical:** toggle **"Listen to events on Connected accounts"** ON.
   (Connect events come from the connected merchant accounts, not your
   platform account — without this toggle the events never reach us.)
5. Click **Add endpoint**.
6. On the endpoint detail page, click **"Reveal"** under "Signing secret"
   → copy the `whsec_…` value.
7. **Vercel** → Env vars → add `STRIPE_WEBHOOK_SECRET` = the `whsec_…` value
   (mark as Sensitive). Save → **Redeploy**.

**Verify:**
- Admin → Readiness should flip `stripe_webhook` from BLOCKER → READY.
- In Stripe → Webhooks → your endpoint, click **"Send test webhook"** →
  pick `charge.succeeded` → check Stripe shows `200 OK` from our endpoint.

---

## 3. Stripe **platform billing** webhook — `IVY_BILLING_WEBHOOK_SECRET` (5 min)

**Why:** When *you* charge a business owner for their Ivy subscription,
Stripe pings `/api/webhooks/billing`. This is your platform account, NOT
Connect. The separate endpoint + secret means subscription events don't
leak across Connect events.

**Steps:**

1. **Stripe Dashboard** → **Developers** → **Webhooks** → **"+ Add endpoint"**.
2. Fill in:
   - **Endpoint URL:** `https://joinivy.ai/api/webhooks/billing`
   - **Description:** `Ivy platform billing`
   - **Events to send:**
     - `checkout.session.completed`
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `invoice.payment_failed`
     - `invoice.upcoming`
3. **"Listen to events on Connected accounts"** → toggle **OFF**
   (billing is on your platform account).
4. **Add endpoint** → copy the `whsec_…` signing secret.
5. **Vercel** → Env vars → add `IVY_BILLING_WEBHOOK_SECRET` = that value
   (Sensitive). Save → **Redeploy**.

**Verify:** Admin → Readiness should flip `billing_webhook` from WARN → READY.

**Alternative — keep them unified:** if you'd rather have ONE webhook
handle both Connect and platform events, leave `IVY_BILLING_WEBHOOK_SECRET`
unset. The code falls back to `STRIPE_WEBHOOK_SECRET` and uses the same
secret for both endpoints. Slightly less isolation; same functionality.

---

## 4. App Store Connect — **App Privacy nutrition labels** (15 min)

**Why:** Apple will reject your submission if these aren't filled in.
They cross-check against your privacy policy text.

**Steps:**

1. Open **App Store Connect** → **My Apps** → your Ivy app.
2. Left sidebar → **App Privacy**.
3. **Privacy Policy URL:** `https://joinivy.ai/privacy`.
4. Click **Get Started** under "Data Types" — declare each category we
   actually collect (Ivy does collect these):

   | Category | Sub-types | Used for | Linked to user? | Tracking? |
   |---|---|---|---|---|
   | **Contact Info** | Email, Name, Phone Number | App Functionality, Customer Support | **Yes** | No |
   | **Identifiers** | User ID | App Functionality, Authentication | Yes | No |
   | **Usage Data** | Product Interaction | Analytics, App Functionality | Yes | No |
   | **Financial Info** | Payment Info | Purchases | Yes | No |
   | **Diagnostics** | Crash Data, Performance | App Functionality | No (anonymous) | No |
   | **User Content** | Other User Content (clients, bookings, invoices, documents) | App Functionality | Yes | No |

   For each one, Apple asks:
   - **Is this data linked to the user's identity?** Yes for everything except diagnostics.
   - **Is this data used for tracking?** No (we don't share with third-party
     data brokers).

5. Click **Save** at the top.

**Verify:** App Store Connect → App Privacy section should show a green
checkmark next to "Data Types declared."

**Note:** if you add a new third-party SDK later (Mixpanel, Amplitude,
etc.), you'll need to update these labels.

---

## 5. App Store Connect — **In-App Purchase products + intro free trial** (15 min)

**Why:** Apple requires IAP for any subscription sold inside the iOS app.
The trial is configured as an Apple **Introductory Free Trial** on each
auto-renewable product. The codebase + RevenueCat are wired for this; ASC
just needs the products and the intro offer set up.

**Steps:**

1. **App Store Connect** → your app → **Monetization** → **Subscriptions**.
2. Click **"+"** next to "Subscription Groups" → name it `ivyos` → **Create**.
3. Inside the group, click **"+"** to add the first product:
   - **Reference Name:** `Ivy — Weekly`
   - **Product ID:** **exactly** `ivyos_weekly` (matches the code).
4. Click **Create** → fill in:
   - **Subscription Duration:** 1 Week
   - **Subscription Prices:** $8.99 USD (and any other currencies)
   - **Localizations:** add at least English:
     - **Display Name:** `Ivy Pro`
     - **Description:** `The all-in-one business OS for solo entrepreneurs. Clients, calendar, invoicing, AI assistant, all in one workspace.`
5. **Introductory Offers** (this is the 14-day free trial):
   - Click **"+"** under "Introductory Offers"
   - **Type:** Free
   - **Duration:** 2 weeks
   - **Number of Periods:** 1
   - **Eligibility:** New subscribers only
   - Save.
6. **Review Information:**
   - **Review Screenshot:** upload a screenshot of your Paywall in the app
     showing the trial (1024×2048 or similar — required for Apple review).
   - **Review Notes:** "14-day free trial then $8.99/week. Tap 'Start
     14-day free trial' on the paywall to begin."
7. Repeat steps 3–6 for the annual product:
   - **Product ID:** `ivyos_yearly`
   - **Duration:** 1 Year
   - **Price:** $375 USD
   - Same intro offer (2 weeks free, new subscribers only).
8. **Submit for Review** at the top of each subscription page (status
   should go from "Missing Metadata" → "Ready to Submit" → "Waiting for
   Review").

**Verify:**
- RevenueCat dashboard → Products → both `ivyos_weekly` and `ivyos_yearly`
  should pull through from App Store Connect (may take ~30 min for sync).
- Push a TestFlight build → open the paywall → StoreKit sheet should read
  **"Free for 14 days, then $8.99/week."**

**Note:** Apple gives one intro offer per Apple ID per subscription group,
ever. Customers who've already redeemed the free trial on iOS won't see
it again — that's Apple's rule, not ours.

---

## 6. App Store Connect — **Reviewer demo account** (5 min)

**Why:** Apple's reviewer needs working credentials to test the paid
features. If they can't sign in, your submission is rejected. The
dev-login endpoint we already built is *perfect* for this.

**Steps:**

1. **App Store Connect** → your app → **App Information** → **General App
   Information** → scroll to **"Sign-In Information"**.
2. Toggle **"Sign-in required"** ON.
3. Enter:
   - **User Name:** `qa@joinivy.ai`
   - **Password:** N/A — instead, fill the **Additional Information** /
     **Notes for the Reviewer** field below with:

     > **Reviewer access (no password needed):**
     > Open this URL on any device — it signs you straight in as a Beta
     > tester with full app access, no card required:
     >
     > `https://joinivy.ai/api/auth/dev-login?token=<YOUR_DEV_LOGIN_SECRET>`
     >
     > Replace `<YOUR_DEV_LOGIN_SECRET>` with the actual secret from
     > `DEV_LOGIN_SECRET` in your Vercel env vars.
     >
     > To test the paywall instead, append `&state=paywall`. To test
     > onboarding, append `&state=onboarding`.

   *(If you'd rather use a password-protected account, just create
   `qa@joinivy.ai` from Admin → Users with a fixed password and put the
   password here.)*

4. **Save**.

**Verify:** Test the URL in incognito to make sure it actually signs in.

---

## 7. **Resend** domain warm-up (1 week, ongoing) (5 min setup)

**Why:** New sending domains have zero email reputation. Hammering 50K
sends on day one lands you in spam. Industry-standard practice is to
ramp volume over ~7 days.

**Steps (one-time setup):**

1. **Resend Dashboard** → **Domains** → confirm `joinivy.ai` shows all
   four records green: **SPF**, **DKIM**, **DMARC**, **MX**.
2. If anything is "Pending," copy the DNS record values into **GoDaddy
   (or your registrar)** → DNS → Add Record. Wait ~10 min, click
   "Verify" in Resend.

**Steps (ramp-up plan, days 1–7 from launch):**

| Day | Send budget | Strategy |
|---|---|---|
| 1 | 50–200 | Internal soft-launch — invite your beta list only. |
| 2 | 200–500 | Same group + a couple of friends-and-family signups. |
| 3 | 500–1,000 | Open to a small public cohort (10–20 customers). |
| 4 | 1,000–2,500 | Watch Resend's "Suppressions" panel — if bounces > 2%, slow down. |
| 5 | 2,500–5,000 | Open marketing fully. |
| 6 | 5,000–10,000 | Normal traffic. |
| 7+ | Uncapped | Domain is warm. |

**Watch in Resend → Domains → your domain:**
- **Bounce rate** should stay under **2%**. >5% means deliverability is
  suffering — pause and investigate.
- **Spam complaint rate** should stay under **0.1%**.

If you see Gmail/Yahoo specifically routing your mail to spam, send a
batch of plain transactional emails (booking confirmations) before any
marketing blasts — those build positive engagement signals.

---

## Final check — Admin → Readiness should be all-green

After all of the above, open `/admin?tab=readiness` in the app. **Every
row should be either OK or "READY"**. The "BLOCKER" + "WARN" badges you
saw earlier should be gone.

If any row is still red:
- Click into it; the detail line tells you exactly what's missing.
- Fix that one thing, redeploy, hit "Re-probe" at the top of the
  Readiness card.

That's the whole list. Code-side, you're 100K-ready. Operator-side,
~75 minutes of dashboard work and you're shippable.
