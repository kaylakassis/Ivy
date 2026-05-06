// /privacy — public Privacy Policy. Generic template; replace placeholders
// (CONTACT_EMAIL, COMPANY_NAME, COMPANY_LOCATION) with real values before
// charging customers, and have a lawyer review before EU rollout.
import React from 'react';
import LegalPage, { H2, P, UL } from './LegalPage.jsx';

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated="May 1, 2026">
      <P>
        This Privacy Policy explains what information THRYVE ("we", "us", "the
        Service") collects from you, how we use it, and what choices you have.
        If anything here is unclear, please email us at{' '}
        <a href="mailto:privacy@getthryve.ai" style={{ color: 'var(--accent)' }}>privacy@getthryve.ai</a>.
      </P>

      <H2>What we collect</H2>
      <P><strong>Account data.</strong> When you sign up we store your email,
        a hashed password (we never see the plaintext), an optional name, and
        a workspace ID associated with your account.</P>
      <P><strong>Business data you create.</strong> Anything you put into your
        workspace — clients, calendar bookings, services, invoices, messages,
        documents, goals, rewards rules, AI chats with Ivy — is stored on your
        behalf so the product can work. We treat this as your data, not ours.</P>
      <P><strong>Operational data.</strong> Server logs, error reports, and
        rate-limit records (used to block brute-force attempts on the sign-in
        page). These are kept for up to 30 days and contain IP addresses but
        no business data.</P>
      <P><strong>What we don't collect.</strong> We don't run third-party
        analytics, ad pixels, or session-replay tools. We don't sell or rent
        your data to anyone.</P>

      <H2>How we use it</H2>
      <UL>
        <li>To run the product (show you your clients, send a magic link, etc.)</li>
        <li>To send transactional email — sign-in confirmations, password resets, invoice notifications, document signing requests.</li>
        <li>To detect and stop abuse (rate limits, fraud signals).</li>
        <li>To respond to support requests when you contact us.</li>
      </UL>
      <P>We don't use your data to train AI models. Conversations with Ivy are
        sent to Anthropic's API to generate replies; Anthropic does not train
        on API content per their data usage policy. We send only what's needed
        to answer the question — not your raw client list or financial data
        unless you reference it explicitly.</P>

      <H2>Who we share it with</H2>
      <UL>
        <li><strong>Vercel</strong> — hosts the application and the static files.</li>
        <li><strong>Neon</strong> — hosts the Postgres database where your workspace data lives.</li>
        <li><strong>Resend</strong> — sends transactional email on our behalf.</li>
        <li><strong>Anthropic</strong> — processes your messages to Ivy and returns AI replies.</li>
        <li><strong>Stripe</strong> — processes any payments you or your clients make through THRYVE (when enabled).</li>
      </UL>
      <P>Each of these is a contracted sub-processor under their own privacy
        terms. We do not share data with anyone else, and we do not sell data.</P>

      <H2>Where it's stored</H2>
      <P>The Postgres database is hosted in the United States. Email and AI
        processing happen in the U.S. as well. If you're outside the U.S.,
        your data will be transferred to and processed in the U.S.</P>

      <H2>How long we keep it</H2>
      <P>We keep workspace data for as long as your account is active. When you
        delete your account, we delete your workspace and all associated data
        (clients, invoices, messages, etc.) within 30 days. Server logs roll
        off automatically after 30 days. Backups may persist for up to 30
        additional days before being overwritten.</P>

      <H2>Your rights</H2>
      <UL>
        <li><strong>Access.</strong> Request a copy of your data — visit Account Settings → Export, or email us.</li>
        <li><strong>Deletion.</strong> Delete your account at any time from Account Settings, or email us. We honor the request within 30 days.</li>
        <li><strong>Correction.</strong> Most fields are editable directly in the app. For anything you can't edit yourself, email us.</li>
        <li><strong>Objection / restriction.</strong> EU and UK residents may object to processing or request restriction; reach us at privacy@getthryve.ai.</li>
        <li><strong>Complaint.</strong> EU residents may also file a complaint with their local data protection authority.</li>
      </UL>

      <H2>Cookies and tracking</H2>
      <P>We use a single cookie — a signed session cookie — to keep you logged
        in. It's HttpOnly, Secure, and SameSite=Lax, and it expires when you
        sign out. We don't use third-party cookies or analytics trackers.</P>

      <H2>Security</H2>
      <P>Passwords are hashed with bcrypt. All traffic is encrypted in transit
        with TLS. Workspace data is isolated at the database level — every
        query is scoped to the requesting user's workspace. Magic-link tokens
        for email verification, password reset, document signing, and invoice
        viewing are SHA-256 hashed before being stored.</P>

      <H2>Children</H2>
      <P>THRYVE is not directed to children under 16. If you believe we have
        collected information from a child, please email us and we will delete
        it.</P>

      <H2>Changes to this policy</H2>
      <P>We may update this policy as the product evolves. Material changes
        will be announced by email at least 14 days before they take effect.</P>

      <H2>Contact</H2>
      <P>Questions about this policy:{' '}
        <a href="mailto:privacy@getthryve.ai" style={{ color: 'var(--accent)' }}>privacy@getthryve.ai</a>.
      </P>
    </LegalPage>
  );
}
