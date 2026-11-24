// /do-not-sell - "Do Not Sell or Share My Personal Information".
//
// The text below is the owner's own, put in word for word as supplied on
// 2026-11-24. Do not reword it. tests/terms-update.test.mjs compares this
// page with the supplied text.
import React from 'react';
import LegalPage, { H2, H3, P, UL } from './LegalPage.jsx';
import LegalLink from '../../components/LegalLink.jsx';

const A = { color: 'var(--accent)' };

export default function DoNotSellPage() {
  return (
    <LegalPage title="Do Not Sell or Share My Personal Information" lastUpdated="November 24, 2026" path="/do-not-sell"
      description="Ivy does not sell or share personal information. This page explains our practices and how to exercise your privacy rights.">
      <H2>Our Commitment to Your Privacy</H2>
      <P>Ivy AI LLC ("Ivy," "we," "us," or "our") respects your privacy and your right to control how your personal information is used.</P>
      <P>The California Consumer Privacy Act, as amended by the California Privacy Rights Act (collectively, the "CCPA"), and other applicable state privacy laws provide individuals with certain rights concerning the sale, sharing, and processing of their personal information.</P>
      <P>This page explains our current practices and how you may exercise applicable privacy rights.</P>

      <H2>We Do Not Sell or Share Your Personal Information</H2>
      <P>Ivy does not sell your personal information.</P>
      <P>We do not:</P>
      <UL>
        <li>Sell personal information for monetary or other valuable consideration as defined under applicable privacy laws.</li>
        <li>Share personal information for cross-context behavioral advertising.</li>
        <li>Process personal information for targeted advertising as defined under applicable state privacy laws.</li>
        <li>Sell, rent, or trade customer lists, client records, invoices, documents, messages, bookings, or other Customer Data to third parties for their own marketing purposes.</li>
        <li>Maintain data-broker relationships for the sale of personal information.</li>
        <li>Operate third-party advertising trackers or session-replay tools as part of our current Service.</li>
      </UL>
      <P>Our business model is based on providing software and subscription services, not selling personal information or monetizing your clients' information through third-party advertising.</P>
      <P>Because we do not currently engage in the sale or sharing of personal information or targeted advertising, there is no such processing activity from which you need to opt out at this time.</P>
      <P>Nevertheless, you may contact us to confirm our practices or exercise applicable privacy rights.</P>

      <H2>How We Use and Disclose Information</H2>
      <P>Ivy processes personal information to provide, maintain, secure, support, and improve its services, administer accounts and subscriptions, and fulfill other purposes described in our Privacy Policy.</P>
      <P>We may disclose information to service providers and subprocessors that support our operations, including providers of:</P>
      <UL>
        <li>Application hosting and infrastructure.</li>
        <li>Database and file storage.</li>
        <li>Artificial intelligence functionality.</li>
        <li>Payment processing.</li>
        <li>Email and SMS communications.</li>
        <li>Calendar integrations.</li>
        <li>Subscription management.</li>
        <li>Security and error monitoring.</li>
        <li>Other authorized Service functionality.</li>
      </UL>
      <P>Where these providers process personal information on our behalf, their processing is subject to applicable contractual restrictions and legal requirements.</P>
      <P>Certain third-party services, including payment processors, app stores, and connected account providers, may independently process information for their own lawful purposes, such as transaction processing, fraud prevention, security, and regulatory compliance.</P>
      <P>These disclosures are not intended to constitute a sale or sharing of personal information for cross-context behavioral advertising under applicable privacy laws.</P>
      <P>Additional information about our data collection, processing, disclosure, and retention practices is available in our <LegalLink to="/privacy" style={A}>Privacy Policy</LegalLink>.</P>

      <H2>Your Privacy Rights</H2>
      <P>Depending on your jurisdiction and applicable law, you may have the right to:</P>
      <UL>
        <li>Opt out of the sale of personal information.</li>
        <li>Opt out of sharing personal information for cross-context behavioral advertising.</li>
        <li>Opt out of targeted advertising.</li>
        <li>Opt out of certain profiling activities that produce legal or similarly significant effects.</li>
        <li>Know what personal information we collect, use, and disclose.</li>
        <li>Access personal information we maintain about you.</li>
        <li>Obtain a portable copy of applicable personal information.</li>
        <li>Request correction of inaccurate personal information.</li>
        <li>Request deletion of personal information, subject to applicable legal exceptions.</li>
        <li>Limit certain uses or disclosures of sensitive personal information.</li>
        <li>Withdraw consent where processing is based on consent.</li>
        <li>Appeal a decision denying an applicable privacy rights request.</li>
        <li>Exercise applicable privacy rights without unlawful discrimination or retaliation.</li>
      </UL>
      <P>The availability and scope of these rights depend on applicable law, the nature of the information, and Ivy's role in processing it.</P>

      <H2>How to Submit a Privacy Request</H2>
      <P>You may submit a privacy rights request by contacting us at:</P>
      <P>Email: <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a></P>
      <P>Suggested subject line: Privacy Rights Request</P>
      <P>Please describe the right you wish to exercise and provide sufficient information for us to identify and respond to your request.</P>
      <P>If you have an Ivy account, submitting your request from the email address associated with your account may help us locate your information.</P>
      <P>However, you do not need to have an Ivy account to submit a privacy request.</P>
      <P>We may request additional information where reasonably necessary to verify your identity or authority, depending on the nature of your request and applicable law.</P>
      <P>We will not require identity verification for opt-out requests where such verification is prohibited by applicable law.</P>
      <P>We will acknowledge and respond to privacy requests within applicable statutory deadlines.</P>
      <P>Where applicable law permits an extension, we will provide notice of the extension and its reason as required.</P>
      <P>We will not charge a fee for exercising applicable privacy rights except where expressly permitted by law.</P>

      <H2>Global Privacy Control and Privacy Preference Signals</H2>
      <P>Global Privacy Control ("GPC") and other legally recognized privacy preference signals allow individuals to communicate certain privacy preferences through supported browsers or devices.</P>
      <P>Where required by applicable law, Ivy recognizes and honors legally recognized opt-out preference signals for processing activities to which those requirements apply.</P>
      <P>Because Ivy does not currently sell personal information, share personal information for cross-context behavioral advertising, or engage in targeted advertising, these signals generally do not require changes to our current processing practices.</P>
      <P>If our practices change, we will implement applicable opt-out mechanisms and honor legally recognized privacy preference signals as required by law.</P>

      <H2>Managing Your Information Through Ivy</H2>
      <P>Account holders may access certain privacy and data management features directly through their Ivy account.</P>

      <H3>Access and Data Portability</H3>
      <P>You may export available workspace information through the data export functionality in Account Settings.</P>
      <P>Workspace exports are provided in JSON format and include applicable business and workspace records maintained on your behalf.</P>
      <P>You may also contact <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a> to request access to applicable personal information that is not included in your workspace export.</P>

      <H3>Account Deletion</H3>
      <P>You may request account deletion through Account Settings or by contacting <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a>.</P>
      <P>Account deletion requests are generally completed within 30 days, subject to applicable law and the retention exceptions described in our Privacy Policy.</P>
      <P>Certain information may be retained where reasonably necessary or legally permitted for:</P>
      <UL>
        <li>Legal and regulatory compliance.</li>
        <li>Tax and accounting obligations.</li>
        <li>Fraud and abuse prevention.</li>
        <li>Security investigations.</li>
        <li>Dispute resolution.</li>
        <li>Enforcement of agreements.</li>
        <li>Backup retention.</li>
      </UL>
      <P>Information retained within backup systems may persist temporarily until removed through ordinary backup rotation.</P>
      <P>Subscriptions purchased directly through Ivy are subject to Ivy's applicable cancellation procedures.</P>
      <P>Subscriptions purchased through Apple or another third-party billing provider may require separate cancellation through that provider's subscription management settings.</P>
      <P>Please review your subscription status to ensure that any applicable recurring charges have been canceled.</P>
      <P>Additional information about account deletion and retention is available in our Privacy Policy and Terms of Service.</P>

      <H2>Sensitive Personal Information</H2>
      <P>Ivy uses sensitive personal information, where collected, for authorized Service functionality, authentication, security, fraud prevention, and other purposes permitted by applicable law.</P>
      <P>We do not use sensitive personal information to infer characteristics about individuals for unrelated advertising purposes.</P>
      <P>Where applicable law provides a right to limit the use or disclosure of sensitive personal information, you may exercise that right by contacting <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a>.</P>

      <H2>If You Are a Client of a Business Using Ivy</H2>
      <P>Businesses use Ivy to manage appointments, client records, invoices, communications, documents, and other business activities.</P>
      <P>If your personal information is maintained by a business using Ivy, that business generally determines how your information is collected and used.</P>
      <P>In these circumstances, Ivy generally acts as a service provider or data processor on behalf of that business.</P>
      <P>Requests concerning information controlled by a business should ordinarily be directed to that business.</P>
      <P>You may also contact <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a>, and we will provide appropriate assistance or refer your request to the relevant business, consistent with applicable law and our contractual obligations.</P>
      <P>Where Ivy independently controls the relevant personal information, we will handle your request directly as required by applicable law.</P>

      <H2>Authorized Agents</H2>
      <P>Where permitted by applicable law, you may authorize another person or organization to submit a privacy rights request on your behalf.</P>
      <P>We may request reasonable evidence of the authorized agent's authority, such as written permission or a legally valid power of attorney.</P>
      <P>Depending on the type of request and applicable law, we may also ask you to verify your identity or confirm that you authorized the agent to act on your behalf.</P>
      <P>We will not impose verification or authorization requirements that are prohibited by applicable law.</P>
      <P>Authorized agents may submit requests to <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a>.</P>

      <H2>Appealing a Privacy Rights Decision</H2>
      <P>Where applicable law provides a right to appeal, you may appeal a decision denying your privacy rights request by contacting:</P>
      <P>Email: <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a></P>
      <P>Suggested subject line: Privacy Rights Appeal</P>
      <P>Please identify the original request and explain why you believe the decision should be reconsidered.</P>
      <P>We will review and respond to your appeal within applicable statutory deadlines.</P>
      <P>Where required by law, we will provide information about how to contact the relevant governmental authority if your appeal is denied.</P>

      <H2>Nondiscrimination and Non-Retaliation</H2>
      <P>Ivy will not unlawfully discriminate or retaliate against you for exercising applicable privacy rights.</P>
      <P>We will not impose unlawful penalties, deny services, charge different prices, or provide a different level or quality of service solely because you exercise an applicable privacy right.</P>
      <P>Certain information may be necessary to provide specific Service functionality. If you request deletion or restriction of information necessary for that functionality, we may be unable to continue providing the affected functionality.</P>
      <P>Any such limitation will be based on the operational requirements of the Service and applicable law, rather than retaliation for exercising privacy rights.</P>

      <H2>Changes to Our Practices</H2>
      <P>We may update this page as our services, data processing practices, and legal obligations evolve.</P>
      <P>If we materially change our practices concerning the sale or sharing of personal information, targeted advertising, or other regulated processing activities, we will provide applicable notices and implement legally required privacy choices before engaging in processing that requires them.</P>
      <P>Where applicable law requires affirmative consent, we will obtain that consent before proceeding with the relevant processing.</P>
      <P>We will also update our Privacy Policy and applicable privacy rights mechanisms as required.</P>

      <H2>Contact Us</H2>
      <P>For questions about our privacy practices, personal information, or applicable privacy rights, please contact:</P>
      <P>Ivy AI LLC</P>
      <P>California, United States</P>
      <P>Email: <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a></P>
      <P>Website: <a href="https://joinivy.ai" style={A}>https://joinivy.ai</a></P>
      <P>Privacy Policy: <LegalLink to="/privacy" style={A}>https://www.joinivy.ai/privacy</LegalLink></P>
      <P>Terms of Service: <LegalLink to="/terms" style={A}>https://www.joinivy.ai/terms</LegalLink></P>
      <P>We will review and respond to privacy inquiries in accordance with applicable legal requirements.</P>
    </LegalPage>
  );
}
