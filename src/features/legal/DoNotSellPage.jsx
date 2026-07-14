// /do-not-sell - California CCPA / CPRA "Do Not Sell or Share My
// Personal Information" page. Required in the footer of every
// California-consumer-facing business (CA SB-1808). Our actual practice
// is that we don't sell or share personal information for cross-context
// behavioral advertising - this page confirms that + gives California
// residents an explicit path to file a request if they want to.
import React from 'react';
import LegalPage, { H2, P } from './LegalPage.jsx';

export default function DoNotSellPage() {
  return (
    <LegalPage title="Do Not Sell or Share My Personal Information" lastUpdated="May 25, 2026">
      <P>
        California's privacy laws (CCPA + CPRA) give residents the right to
        opt out of the "sale" or "sharing" of their personal information.
        This page explains what we do and how to exercise that right with
        Ivy.
      </P>

      <H2>What we do today</H2>
      <P>
        <strong>We do not sell your personal information for money.</strong>{' '}
        We do not share personal information for cross-context behavioral
        advertising. We have no advertising business, no data-broker
        relationships, and no third-party trackers on the application
        surface where you sign in and use Ivy.
      </P>
      <P>
        Personal information you provide (your name, email, business data,
        client records) is used to run the Service for you. It flows to the
        sub-processors listed on our{' '}
        <a href="/privacy" style={{ color: 'var(--accent)' }}>Privacy Policy</a>{' '}
        - payment, email, AI, and infrastructure providers - strictly to
        deliver the product you signed up for. None of these relationships
        constitute a "sale" or "sharing" under the CCPA/CPRA definitions.
      </P>

      <H2>Exercising your rights</H2>
      <P>
        Even though our practice is "no sale, no share", California
        residents may formally confirm that opt-out status on the record.
        To do so, or to file any other CCPA/CPRA request (access, deletion,
        correction, portability, limit use of sensitive personal
        information), email us at{' '}
        <a href="mailto:privacy@joinivy.ai" style={{ color: 'var(--accent)' }}>privacy@joinivy.ai</a>{' '}
        from the email address tied to your Ivy account. We will respond
        within 45 days as the law requires.
      </P>
      <P>
        Two other paths are available from inside your account:
      </P>
      <ul style={{ marginLeft: 22, lineHeight: 1.6 }}>
        <li>
          <strong>Access / Portability:</strong>{' '}
          <em>Account → Download my data</em> exports your full workspace
          as JSON, including the data we hold on your behalf.
        </li>
        <li>
          <strong>Deletion:</strong>{' '}
          <em>Account → Delete account</em> soft-deletes your account
          immediately + hard-deletes it within 30 days. Stripe
          subscriptions are cancelled in the same flow.
        </li>
      </ul>

      <H2>Authorized agents</H2>
      <P>
        If you're authorizing someone else to submit a request on your
        behalf, include written authorization (signed PDF attached to the
        email) plus enough information for us to verify your identity. We
        may ask the consumer directly to confirm before acting on the
        request.
      </P>

      <H2>Non-retaliation</H2>
      <P>
        Exercising any of these rights does not affect the price you pay
        for Ivy or the service you receive. We don't run different
        pricing tiers based on whether you opt out - there are no opt-out
        penalties because we don't have an ad-tech model to penalize.
      </P>

      <H2>Updates</H2>
      <P>
        We'll keep this page current as our practices evolve and as the
        law changes. If our actual sale/share practices ever change (they
        won't without notice), we will update this page + email all
        affected users + re-prompt for acceptance of the Privacy Policy.
      </P>
    </LegalPage>
  );
}
