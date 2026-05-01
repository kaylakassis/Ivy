// /terms — public Terms of Service. Generic template; have a lawyer review
// before you charge customers, especially if EU/UK users are in scope.
import React from 'react';
import LegalPage, { H2, P, UL } from './LegalPage.jsx';

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" lastUpdated="May 1, 2026">
      <P>
        These Terms govern your use of THRYVE (the "Service"). By creating an
        account or using the Service you agree to them. If you don't agree,
        don't use the Service.
      </P>

      <H2>Your account</H2>
      <P>You're responsible for keeping your password safe and for everything
        that happens under your account. Notify us immediately at{' '}
        <a href="mailto:support@thryve.app" style={{ color: 'var(--accent)' }}>support@thryve.app</a>{' '}
        if you suspect unauthorized access. You must be at least 16 years old
        and able to enter into a binding contract under the laws of your
        country.</P>

      <H2>Acceptable use</H2>
      <P>Don't use THRYVE to:</P>
      <UL>
        <li>Break the law or facilitate illegal activity.</li>
        <li>Send spam, malware, phishing links, or unwanted bulk email.</li>
        <li>Harass, threaten, or impersonate other people.</li>
        <li>Reverse-engineer, scrape, or attack the Service or its infrastructure.</li>
        <li>Resell the Service, or use it to build a competing product.</li>
      </UL>
      <P>We reserve the right to suspend or terminate accounts that violate
        these rules. Material violations may be terminated immediately and
        without notice.</P>

      <H2>Your content</H2>
      <P>You keep ownership of everything you put into THRYVE — clients,
        invoices, documents, messages, content. You grant us a limited license
        to host, transmit, and process that content only as needed to operate
        the Service.</P>
      <P>You're responsible for the legality of your content. If you handle
        personal data about your own clients through THRYVE, you are the data
        controller; we are the processor. You must have a lawful basis for
        the data you collect and a way for your clients to exercise their
        rights.</P>

      <H2>Service availability</H2>
      <P>We aim to keep THRYVE available 24/7 but cannot guarantee
        uninterrupted service. We perform maintenance and may push updates
        that briefly disrupt access. We are not liable for downtime or for
        data loss caused by force majeure events. Keep your own backups of
        anything irreplaceable.</P>

      <H2>Fees</H2>
      <P>Paid plans are billed in advance on a recurring basis (monthly or
        annually as you select). Fees are non-refundable except where
        required by law. If you cancel, you keep access until the end of the
        current billing period.</P>
      <P>We may change prices with at least 30 days' notice via email. Price
        changes take effect at your next renewal.</P>

      <H2>Third-party services</H2>
      <P>THRYVE integrates with services we don't operate (Anthropic for AI
        replies, Stripe for payments, Resend for email, etc.). Your use of
        those services is governed by their own terms. We're not responsible
        for their behavior or outages.</P>

      <H2>AI features</H2>
      <P>Ivy generates suggestions based on your workspace data and a large
        language model. Output may be incorrect or outdated. Treat Ivy as a
        coach, not a source of professional advice. Verify anything important
        — especially financial, tax, or legal recommendations — with a
        qualified human.</P>

      <H2>Termination</H2>
      <P>You can delete your account at any time from Account Settings or by
        emailing us. We'll remove your workspace and associated data within
        30 days. We may terminate or suspend accounts that violate these
        Terms, abuse the Service, or fail to pay.</P>

      <H2>Disclaimers</H2>
      <P>The Service is provided "as is" without warranties of any kind,
        express or implied, including but not limited to merchantability,
        fitness for a particular purpose, and non-infringement. We do not
        warrant that the Service will be error-free, secure, or
        uninterrupted, or that it will meet your business goals.</P>

      <H2>Limitation of liability</H2>
      <P>To the maximum extent permitted by law, THRYVE will not be liable
        for any indirect, incidental, special, consequential, or punitive
        damages, or any loss of profits or revenues, whether incurred
        directly or indirectly, or any loss of data, use, goodwill, or
        other intangible losses. Our total liability for any claim arising
        out of or related to these Terms or the Service is limited to the
        greater of (a) the amount you paid us in the 12 months before the
        claim and (b) US $100.</P>

      <H2>Indemnification</H2>
      <P>You agree to defend and indemnify us against any third-party claim
        arising from your use of the Service, your content, or your
        violation of these Terms.</P>

      <H2>Changes</H2>
      <P>We may update these Terms as the product evolves. Material changes
        will be announced by email at least 14 days before they take effect.
        Continued use after a change means you accept the new Terms.</P>

      <H2>Governing law</H2>
      <P>These Terms are governed by the laws of the State of California,
        excluding its conflict-of-law rules. Disputes will be resolved in
        the state or federal courts located in San Francisco County,
        California, and you consent to that jurisdiction.</P>

      <H2>Contact</H2>
      <P>Questions:{' '}
        <a href="mailto:support@thryve.app" style={{ color: 'var(--accent)' }}>support@thryve.app</a>.
      </P>
    </LegalPage>
  );
}
