// /terms - public Terms of Service.
//
// This is template language drafted to err on the side of broad
// disclaimers and limit Ivy's liability for AI output, business
// outcomes, and third-party integrations. **It is not a substitute for
// review by a qualified attorney in your jurisdiction.** Have a real
// lawyer adapt this for your business before you charge anyone or
// scale beyond friendly beta users.
//
// Bumping the version: change CURRENT_TERMS_VERSION in api/_lib/legal.js
// and TERMS_VERSION below to match. Every existing user will be
// force-prompted to re-accept on their next request.
import React from 'react';
import LegalPage, { H2, P, UL } from './LegalPage.jsx';

export const TERMS_VERSION = '2026-05-05';

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" lastUpdated="May 5, 2026">
      <P><strong>Effective version: {TERMS_VERSION}.</strong> These Terms
        of Service ("Terms") govern your access to and use of Ivy (the
        "Service"), operated by Ivy ("Ivy", "we",
        "us"). By creating an account or using the Service, you confirm
        you have read, understood, and agree to be bound by these
        Terms. If you do not agree, do not use the Service.</P>

      <H2>1. Eligibility &amp; account</H2>
      <P>You must be at least 18 years old (or the age of majority in
        your jurisdiction) and able to enter into a legally binding
        contract. You're responsible for keeping your credentials safe
        and for everything that happens under your account. Notify us
        immediately at{' '}
        <a href="mailto:support@joinivy.ai" style={{ color: 'var(--accent)' }}>support@joinivy.ai</a>{' '}
        if you suspect unauthorized access.</P>

      <H2>2. The Service is informational, not professional advice</H2>
      <P><strong>Ivy - including the Ivy AI assistant, every dashboard
        metric, every suggested action, every email, every report
        export, and every integration - provides informational tools
        only. Nothing in the Service constitutes financial, legal, tax,
        accounting, medical, or other professional advice.</strong> Your
        business decisions are yours alone, and you remain solely
        responsible for them.</P>
      <P><strong>You are strongly encouraged to consult a licensed
        financial advisor, certified public accountant, attorney, or
        other qualified professional</strong> before relying on any
        output from the Service for material decisions affecting your
        business, finances, taxes, contracts, or compliance
        obligations.</P>

      <H2>3. AI output (Ivy and similar features)</H2>
      <P>Ivy and other AI-driven features generate output by
        statistical inference on a large language model. The output may
        be inaccurate, incomplete, biased, outdated, or misleading,
        even when it sounds confident.</P>
      <UL>
        <li><strong>Ivy is not a financial advisor, attorney, accountant,
          tax preparer, or any other licensed professional.</strong></li>
        <li>Suggestions Ivy makes about pricing, retention, marketing,
          or messaging are starting points for your own judgment, not
          recommendations you should act on without verification.</li>
        <li>Drafts Ivy composes for you (messages, emails, agreements)
          remain <em>your</em> communications once you send them; you
          are responsible for their accuracy and legality.</li>
        <li>Ivy may invoke tools that perform actions in your workspace
          (sending messages, marking invoices paid, creating clients).
          Those actions are taken by you, through Ivy. You are
          responsible for them and for monitoring Ivy's behavior.</li>
      </UL>

      <H2>4. Business outcomes - no guarantees</H2>
      <P><strong>Ivy does not guarantee any specific business
        outcome.</strong> We make no representation that using the
        Service will increase your revenue, reduce churn, attract
        clients, prevent no-shows, improve your tax position, ensure
        compliance with any law or regulation, or produce any other
        result. Outcomes depend on factors entirely outside our
        control - your market, your effort, your pricing, your local
        regulations, and many others.</P>

      <H2>5. Third-party integrations</H2>
      <P>The Service integrates with services operated by third
        parties, including but not limited to:</P>
      <UL>
        <li><strong>Anthropic</strong> (large language model behind Ivy)</li>
        <li><strong>Stripe</strong> (payments + Stripe Connect)</li>
        <li><strong>Twilio</strong> (SMS, when you connect your account)</li>
        <li><strong>Google</strong> (calendar sync, when you connect)</li>
        <li><strong>Resend</strong> (transactional email)</li>
        <li><strong>Vercel</strong> (hosting)</li>
        <li><strong>Neon</strong> / <strong>Postgres</strong> (database)</li>
      </UL>
      <P>Your use of these third-party services is governed by their
        own terms and privacy policies. <strong>Ivy is not
        responsible for the availability, accuracy, security, or
        behavior of any third-party service, nor for any loss arising
        from their outages, errors, breaches, fee changes, or terms of
        service changes.</strong> Where you connect your own account
        (Stripe, Twilio, Google), the relationship is between you and
        the third party; we facilitate the integration but do not
        assume liability for it.</P>

      <H2>6. Acceptable use</H2>
      <P>You agree not to use the Service to:</P>
      <UL>
        <li>Break any applicable law or facilitate illegal activity.</li>
        <li>Send unsolicited bulk email, malware, phishing links, or spam.</li>
        <li>Harass, threaten, defame, or impersonate any person.</li>
        <li>Collect data about people without a lawful basis to do so.</li>
        <li>Reverse-engineer, scrape, attack, or attempt to gain
          unauthorized access to the Service or its infrastructure.</li>
        <li>Resell the Service, sublicense it, or use it to build a
          competing product.</li>
        <li>Provide regulated services (medical, legal, financial,
          investment) through the Service unless you are
          professionally licensed and your use complies with all
          applicable regulations.</li>
      </UL>
      <P>We reserve the right to suspend or terminate accounts that
        violate these rules, in our sole discretion, and without
        liability.</P>

      <H2>7. Your content &amp; data</H2>
      <P>You retain ownership of everything you put into Ivy -
        clients, invoices, documents, messages, files, and any other
        content you create or upload ("Customer Data"). You grant us
        a worldwide, non-exclusive, royalty-free license to host,
        store, transmit, display, and process Customer Data solely as
        needed to operate the Service.</P>
      <P>If Customer Data includes personal data about other people
        (including your own clients), <strong>you are the controller
        and we are the processor</strong>. You represent that you have
        a lawful basis to collect and process that data, that you have
        provided required notices to data subjects, and that you will
        respond to their rights requests as required by applicable law
        (including GDPR/CCPA where applicable).</P>
      <P><strong>Product analytics &amp; aggregate metrics.</strong>
        We measure how the Service is used at the platform level -
        sign-ups, active accounts, feature adoption, conversion,
        retention, revenue across the platform, and similar usage
        signals - and we use those metrics to improve the product and
        inform our marketing and growth efforts. We may publish or
        share aggregate, de-identified statistics ("our customers
        average X bookings per month") that cannot be linked back to
        you or your clients.</P>
      <P><strong>We will never sell your data.</strong> We do not
        sell, rent, or trade Customer Data, your personal
        information, or your clients' personal information to third
        parties for their own marketing or commercial use. Period.
        See the Privacy Policy for the full list of sub-processors
        who handle data only to operate the Service on our behalf.</P>

      <H2>8. Service availability</H2>
      <P>We aim to keep Ivy available but make no uptime guarantee.
        Maintenance, updates, and force-majeure events may disrupt
        access. <strong>You are responsible for keeping your own
        backups of anything irreplaceable.</strong> The Account
        Settings page provides a full JSON export of your workspace
        for this purpose.</P>

      <H2>9. Fees and billing</H2>
      <P>The Service is currently in free beta. When paid plans
        launch, fees will be charged in advance on a recurring basis
        (monthly or annual) and are non-refundable except where
        required by law. If you cancel, you retain access until the
        end of the then-current billing period.</P>
      <P>We may change prices with at least 30 days' notice via email.
        Price changes take effect at your next renewal. Stripe
        processing fees are charged separately by Stripe and are not
        part of Ivy's pricing.</P>

      <H2>10. Termination</H2>
      <P>You may delete your account at any time from Account
        Settings, which permanently removes your workspace and
        associated data within 30 days. We may terminate or suspend
        your account immediately, without notice, if you violate
        these Terms, abuse the Service, fail to pay, or engage in
        conduct we reasonably believe is harmful to other users or to
        us.</P>

      <H2>11. Disclaimers</H2>
      <P>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT
        WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING
        BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY,
        FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, OR COURSE
        OF PERFORMANCE. WE DO NOT WARRANT THAT THE SERVICE WILL BE
        UNINTERRUPTED, TIMELY, SECURE, OR ERROR-FREE; THAT DEFECTS
        WILL BE CORRECTED; OR THAT THE SERVICE OR ANY OUTPUT FROM IT
        WILL BE ACCURATE OR RELIABLE FOR ANY PARTICULAR PURPOSE.</P>

      <H2>12. Limitation of liability</H2>
      <P>TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT WILL
        Ivy, ITS OFFICERS, EMPLOYEES, CONTRACTORS, OR LICENSORS BE
        LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL,
        OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUES,
        DATA, USE, GOODWILL, BUSINESS OPPORTUNITIES, CLIENTS, OR
        OTHER INTANGIBLE LOSSES, ARISING OUT OF OR RELATED TO YOUR
        USE OF THE SERVICE - WHETHER BASED ON CONTRACT, TORT,
        STRICT LIABILITY, OR ANY OTHER LEGAL THEORY, AND WHETHER OR
        NOT WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH
        DAMAGES.</P>
      <P>OUR TOTAL CUMULATIVE LIABILITY ARISING OUT OF OR RELATED TO
        THESE TERMS OR THE SERVICE WILL NOT EXCEED THE GREATER OF
        (a) THE AMOUNT YOU PAID Ivy IN THE TWELVE (12) MONTHS
        IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO THE CLAIM, OR
        (b) ONE HUNDRED U.S. DOLLARS (USD $100.00).</P>
      <P>The exclusions and limitations in this section apply
        regardless of whether liability arises from breach of contract,
        breach of warranty, tort (including negligence), strict
        liability, or any other theory. Some jurisdictions do not
        allow certain exclusions, in which case the exclusions apply
        only to the extent permitted.</P>

      <H2>13. Release of liability</H2>
      <P><strong>You acknowledge that you use the Service at your own
        risk and release Ivy from any and all claims, damages,
        losses, costs, and expenses (including reasonable attorneys'
        fees) arising from or related to:</strong></P>
      <UL>
        <li>Your business decisions, results, profitability, or losses,
          including those informed in any part by the Service or by
          Ivy's output.</li>
        <li>Your tax, legal, regulatory, licensing, or compliance
          obligations and the consequences of any failure to meet
          them.</li>
        <li>Any communication you send through the Service to your
          clients or other recipients, including drafts authored or
          assisted by Ivy.</li>
        <li>Any third-party integration's behavior, outage, fee
          change, breach, or termination.</li>
        <li>Any disputes between you and your own clients, including
          disputes about appointments, payments, refunds, or
          documents.</li>
      </UL>

      <H2>14. Indemnification</H2>
      <P>You agree to defend, indemnify, and hold harmless Ivy,
        its officers, employees, contractors, and licensors from and
        against any claim, demand, loss, liability, cost, or expense
        (including reasonable attorneys' fees) arising out of: (a)
        your use of the Service; (b) your content or data; (c) your
        violation of these Terms; (d) your violation of any law or
        regulation; or (e) any dispute between you and a third party
        (including your own clients).</P>

      <H2>15. Changes to these Terms</H2>
      <P>We may update these Terms as the product and legal
        environment evolve. When we make material changes, we will
        announce them by email and/or in-app at least fourteen (14)
        days before they take effect, and we will require you to
        accept the updated version before continuing to use the
        Service. Continued use after a change means you accept the
        new Terms.</P>

      <H2>16. Governing law &amp; disputes</H2>
      <P>These Terms are governed by the laws of the State of
        California, USA, excluding its conflict-of-law rules. Any
        dispute arising out of or related to these Terms or the
        Service will be resolved in the state or federal courts
        located in San Francisco County, California, and you consent
        to the personal jurisdiction of those courts.</P>
      <P>You agree that any claim must be brought in your individual
        capacity and not as a plaintiff or class member in any
        purported class or representative proceeding.</P>

      <H2>17. Severability &amp; entire agreement</H2>
      <P>If any provision of these Terms is held invalid or
        unenforceable, the remaining provisions remain in full force
        and effect, and the invalid provision is replaced with one
        that comes closest to the original intent. These Terms,
        together with the Privacy Policy, constitute the entire
        agreement between you and Ivy regarding the Service and
        supersede any prior agreements.</P>

      <H2>18. Contact</H2>
      <P>Questions about these Terms:{' '}
        <a href="mailto:support@joinivy.ai" style={{ color: 'var(--accent)' }}>support@joinivy.ai</a>.
      </P>
    </LegalPage>
  );
}
