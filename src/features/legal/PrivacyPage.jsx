// /privacy - public Privacy Policy.
//
// The text below is the owner's own, put in word for word as supplied on
// 2026-11-24 (26 sections). Do not reword it: a change to what it says is
// hers (and her lawyer's) to make. tests/terms-update.test.mjs compares
// this page with the supplied text, so an accidental edit fails the build.
//
// Bumping the version: change CURRENT_PRIVACY_VERSION in api/_lib/legal.js
// (+ the mirror in src/lib/legal.js) and PRIVACY_VERSION below to match,
// and add the outgoing version to PRIOR_PRIVACY_VERSIONS. Existing users
// then see the "We updated our Privacy Policy" notice.
import React from 'react';
import LegalPage, { H2, H3, P, UL } from './LegalPage.jsx';
import LegalLink from '../../components/LegalLink.jsx';

export const PRIVACY_VERSION = '2026-11-24';

export const PRIVACY_LAST_UPDATED = 'November 24, 2026';
export const PRIVACY_EFFECTIVE = 'December 8, 2026';

const A = { color: 'var(--accent)' };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated={PRIVACY_LAST_UPDATED} effectiveDate={PRIVACY_EFFECTIVE} path="/privacy"
      description="Ivy's Privacy Policy explains how Ivy collects, uses, keeps, discloses and protects information, and what choices you have.">
      <PrivacyPolicyBody/>
    </LegalPage>
  );
}

// The policy text on its own, so the in-app "We updated our Privacy Policy"
// notice can show the whole thing inline.
export function PrivacyPolicyBody() {
  return (
    <>
      <P>Ivy AI LLC ("Ivy," "Company," "we," "us," or "our") respects your privacy and is committed to protecting personal information.</P>
      <P>This Privacy Policy explains how we collect, use, process, retain, disclose, and protect information when you access or use Ivy, including our websites, mobile applications, artificial intelligence features, booking pages, client portals, communications, integrations, and related services (collectively, the "Service").</P>
      <P>This Privacy Policy applies to business owners, account holders, authorized workspace users, prospective customers, website visitors, and individuals who interact with businesses using Ivy.</P>
      <P>Questions concerning this Privacy Policy may be directed to <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a>.</P>

      <H2>1. Our Role in Processing Personal Information</H2>
      <P>Ivy provides software tools that help businesses manage their operations, clients, appointments, communications, documents, payments, and other business activities.</P>
      <P>Our responsibilities concerning personal information depend on the circumstances in which that information is processed.</P>

      <H3>1.1 Information we process for our own purposes</H3>
      <P>Ivy may act as a business or data controller when we independently determine the purposes and means of processing personal information.</P>
      <P>This includes certain processing activities relating to:</P>
      <UL>
        <li>Account registration and administration.</li>
        <li>Subscription management and billing.</li>
        <li>Customer support.</li>
        <li>Platform security and fraud prevention.</li>
        <li>Product analytics and improvement.</li>
        <li>Marketing our own services.</li>
        <li>Compliance with legal obligations.</li>
      </UL>

      <H3>1.2 Information we process on behalf of businesses</H3>
      <P>When a business uses Ivy to manage information about its clients, employees, contractors, or other individuals, Ivy generally acts as a service provider or data processor to the extent applicable under relevant privacy laws.</P>
      <P>The business determines the purposes for which that information is collected and processed.</P>
      <P>We process such information according to authorized business instructions, applicable contractual obligations, and applicable law.</P>
      <P>Businesses using Ivy are responsible for providing appropriate privacy notices, obtaining required permissions and consents, establishing lawful processing grounds, and responding to applicable individual privacy rights requests.</P>
      <P>Where applicable, additional processing obligations may be established through a Data Processing Addendum.</P>

      <H2>2. Information We Collect</H2>
      <P>The information we collect depends on how you interact with the Service, which features you use, and which permissions you provide.</P>

      <H3>2.1 Account and registration information</H3>
      <P>When you create or manage an Ivy account, we may collect:</P>
      <UL>
        <li>Your name.</li>
        <li>Email address.</li>
        <li>Phone number, if provided.</li>
        <li>Account credentials in protected or hashed form.</li>
        <li>Account preferences.</li>
        <li>Country and approximate geographic location inferred from your IP address.</li>
        <li>Business location and business profile information.</li>
        <li>Business development stage.</li>
        <li>Information about how you discovered Ivy.</li>
        <li>Subscription status.</li>
        <li>Notification preferences.</li>
        <li>Device notification identifiers.</li>
      </UL>
      <P>We use this information to establish, administer, secure, and support your account.</P>

      <H3>2.2 Business and workspace information</H3>
      <P>When you use Ivy to operate your business, we may process information you create, upload, receive, or otherwise make available through your workspace.</P>
      <P>This may include:</P>
      <UL>
        <li>Client names and contact information.</li>
        <li>Appointment and booking information.</li>
        <li>Calendar information.</li>
        <li>Services and pricing.</li>
        <li>Invoices and payment records.</li>
        <li>Business revenue and financial summaries.</li>
        <li>Documents, agreements, and uploaded files.</li>
        <li>Messages and communications.</li>
        <li>Website and booking page content.</li>
        <li>Business goals and performance information.</li>
        <li>Rewards and loyalty program information.</li>
        <li>Automation settings.</li>
        <li>Artificial intelligence conversations and related outputs.</li>
        <li>Other information you choose to provide.</li>
      </UL>
      <P>We refer to information submitted to or generated within your workspace on your behalf as "Customer Data."</P>
      <P>You retain your applicable ownership rights in Customer Data, as described in our Terms of Service.</P>

      <H3>2.3 Information about clients of businesses using Ivy</H3>
      <P>If you interact with a business through an Ivy-powered website, booking page, invoice, document, or client portal, we may process information such as:</P>
      <UL>
        <li>Your name.</li>
        <li>Email address.</li>
        <li>Phone number.</li>
        <li>Appointment details.</li>
        <li>Services requested or purchased.</li>
        <li>Payment and transaction information.</li>
        <li>Documents and electronic signatures.</li>
        <li>Communications with the business.</li>
        <li>Information you submit through forms or other business-controlled features.</li>
      </UL>
      <P>We generally process this information on behalf of the business with which you interact.</P>
      <P>That business may maintain its own privacy practices and is responsible for its independent use of your information.</P>

      <H3>2.4 Payment and subscription information</H3>
      <P>When you purchase an Ivy subscription or make a payment through an integrated payment service, we may receive or maintain:</P>
      <UL>
        <li>Transaction identifiers.</li>
        <li>Payment amounts.</li>
        <li>Currency.</li>
        <li>Payment status.</li>
        <li>Subscription status.</li>
        <li>Billing history.</li>
        <li>Refund and dispute information.</li>
        <li>Other transaction-related information provided by the applicable payment provider.</li>
      </UL>
      <P>Payment card information is generally collected and processed directly by the applicable payment processor or app store.</P>
      <P>Ivy does not intentionally collect or store complete payment card numbers or card security codes within ordinary workspace records.</P>
      <P>Payment providers may independently collect additional information under their own privacy policies.</P>

      <H3>2.5 Technical and operational information</H3>
      <P>When you access the Service, we may automatically collect technical and operational information, including:</P>
      <UL>
        <li>IP addresses.</li>
        <li>Browser and device information.</li>
        <li>Operating system information.</li>
        <li>Authentication and session information.</li>
        <li>Server logs.</li>
        <li>Error and diagnostic reports.</li>
        <li>Access timestamps.</li>
        <li>Rate-limit records.</li>
        <li>Security and fraud prevention signals.</li>
        <li>Unusual or potentially unauthorized activity.</li>
      </UL>
      <P>We use this information to operate, maintain, troubleshoot, secure, and improve the Service.</P>

      <H3>2.6 Product analytics and usage information</H3>
      <P>We collect information about how the Service is used, including:</P>
      <UL>
        <li>Account registrations.</li>
        <li>Active accounts.</li>
        <li>Feature adoption.</li>
        <li>Feature usage frequency.</li>
        <li>Conversion and subscription activity.</li>
        <li>Customer retention and churn.</li>
        <li>Platform performance.</li>
        <li>Broad business activity indicators, such as completed bookings or paid invoices.</li>
      </UL>
      <P>Certain analytics may be associated with individual accounts or workspaces to help us understand product usage, provide support, identify technical issues, and improve the Service.</P>
      <P>We do not use Customer Data to create advertising profiles for unrelated third parties.</P>

      <H3>2.7 Business performance totals</H3>
      <P>Ivy may calculate business-level summaries from information maintained within your workspace.</P>
      <P>These may include:</P>
      <UL>
        <li>Total revenue recorded or collected through Ivy.</li>
        <li>Number of clients.</li>
        <li>Number of appointments and bookings.</li>
        <li>Invoice activity.</li>
        <li>Feature usage.</li>
        <li>Other business performance indicators.</li>
      </UL>
      <P>Access to identifiable business performance information is restricted to authorized personnel and service providers with a legitimate operational need.</P>
      <P>We may use such information to provide functionality, support customers, maintain the Service, and understand product performance, subject to applicable contractual and legal restrictions.</P>
      <P>We do not publicly disclose identifiable business performance information without appropriate authorization or another lawful basis.</P>

      <H3>2.8 Support and communications information</H3>
      <P>If you contact Ivy, we may collect:</P>
      <UL>
        <li>Your contact information.</li>
        <li>The contents of your communications.</li>
        <li>Support requests.</li>
        <li>Feedback and suggestions.</li>
        <li>Information reasonably necessary to investigate or resolve your request.</li>
      </UL>
      <P>Please avoid including unnecessary sensitive personal information in support communications.</P>

      <H2>3. Sources of Personal Information</H2>
      <P>We may obtain personal information from:</P>
      <UL>
        <li>You directly.</li>
        <li>Businesses and authorized workspace users.</li>
        <li>Individuals interacting with Ivy-powered business pages.</li>
        <li>Your devices and interactions with the Service.</li>
        <li>Connected third-party services.</li>
        <li>Payment processors and app stores.</li>
        <li>Service providers supporting our operations.</li>
        <li>Information generated through authorized use of the Service.</li>
      </UL>
      <P>We collect and process information only for purposes permitted by applicable law and relevant contractual obligations.</P>

      <H2>4. How We Use Information</H2>
      <P>We may use personal information for the following purposes:</P>

      <H3>4.1 Providing the Service</H3>
      <UL>
        <li>Creating and maintaining accounts.</li>
        <li>Managing workspaces.</li>
        <li>Providing scheduling, booking, invoicing, and client management functionality.</li>
        <li>Processing authorized communications.</li>
        <li>Providing artificial intelligence features.</li>
        <li>Operating websites and client portals.</li>
        <li>Maintaining documents and business records.</li>
        <li>Synchronizing connected services.</li>
        <li>Processing authorized automations.</li>
      </UL>

      <H3>4.2 Account administration and billing</H3>
      <UL>
        <li>Managing subscriptions.</li>
        <li>Processing or facilitating payments.</li>
        <li>Providing invoices and receipts.</li>
        <li>Managing trials and renewals.</li>
        <li>Communicating billing information.</li>
        <li>Preventing fraudulent transactions and subscription abuse.</li>
      </UL>

      <H3>4.3 Security and fraud prevention</H3>
      <UL>
        <li>Authenticating users.</li>
        <li>Protecting accounts and workspaces.</li>
        <li>Detecting unauthorized access.</li>
        <li>Preventing automated abuse and unauthorized data extraction.</li>
        <li>Investigating security incidents.</li>
        <li>Enforcing our Terms of Service.</li>
        <li>Protecting the rights, property, and safety of Ivy, its users, and others.</li>
      </UL>

      <H3>4.4 Customer support</H3>
      <UL>
        <li>Responding to inquiries.</li>
        <li>Troubleshooting technical problems.</li>
        <li>Investigating reported issues.</li>
        <li>Providing account assistance.</li>
        <li>Communicating relevant service information.</li>
      </UL>

      <H3>4.5 Product improvement and analytics</H3>
      <UL>
        <li>Measuring feature usage.</li>
        <li>Understanding product performance.</li>
        <li>Identifying technical and usability issues.</li>
        <li>Evaluating customer retention and subscription activity.</li>
        <li>Improving existing functionality.</li>
        <li>Developing new features.</li>
        <li>Understanding demand for our services.</li>
      </UL>
      <P>Where information is processed on behalf of a business customer, these activities remain subject to applicable processor and service-provider restrictions.</P>

      <H3>4.6 Marketing and business development</H3>
      <P>We may use appropriate account information and platform-level analytics to understand demand for Ivy, evaluate marketing performance, and promote our own services.</P>
      <P>We may send product updates, educational information, offers, and other marketing communications where you have opted in or otherwise where permitted by applicable law.</P>
      <P>You may unsubscribe from marketing communications at any time.</P>
      <P>We do not sell your client lists or Customer Data to third parties for their own marketing purposes.</P>

      <H3>4.7 Legal and regulatory purposes</H3>
      <P>We may process information to:</P>
      <UL>
        <li>Comply with applicable laws and regulations.</li>
        <li>Respond to lawful governmental requests.</li>
        <li>Maintain legally required records.</li>
        <li>Establish, exercise, or defend legal claims.</li>
        <li>Investigate suspected unlawful activity.</li>
        <li>Enforce contractual rights and obligations.</li>
      </UL>

      <H2>5. Artificial Intelligence and Automated Features</H2>

      <H3>5.1 AI processing</H3>
      <P>Ivy incorporates artificial intelligence features powered by third-party large language model providers.</P>
      <P>When you interact with Ivy's artificial intelligence features, information may be transmitted to an AI service provider to generate responses, analyze information, or perform requested functionality.</P>
      <P>Depending on the feature and your instructions, information processed may include:</P>
      <UL>
        <li>Your messages and prompts.</li>
        <li>Relevant conversation history.</li>
        <li>Information retrieved from your workspace.</li>
        <li>Client or appointment information.</li>
        <li>Business and financial summaries.</li>
        <li>Documents or other content you provide.</li>
        <li>Tool instructions and tool-generated results.</li>
        <li>Other contextual information reasonably necessary to provide the requested functionality.</li>
      </UL>
      <P>We seek to limit information transmitted to AI providers to information reasonably necessary for the applicable feature.</P>
      <P>AI features may retrieve relevant workspace information based on your instructions and enabled functionality, even where you do not manually include that information in your message.</P>

      <H3>5.2 AI model training</H3>
      <P>Ivy does not use your Customer Data or private AI conversations to train general-purpose artificial intelligence models.</P>
      <P>Our AI service arrangements are intended to prohibit providers from using Customer Data submitted through Ivy to train their general-purpose models.</P>
      <P>AI providers may process or temporarily retain information for authorized service delivery, security, abuse prevention, or legally required purposes, subject to applicable contractual arrangements and provider settings.</P>
      <P>A restriction on model training does not necessarily mean that information is never temporarily retained by an AI service provider.</P>

      <H3>5.3 AI-assisted actions</H3>
      <P>Certain AI features may perform actions within your workspace or connected services when requested or authorized.</P>
      <P>These actions may involve retrieving, creating, modifying, transmitting, or otherwise processing information.</P>
      <P>Examples include:</P>
      <UL>
        <li>Creating or updating client records.</li>
        <li>Managing appointments.</li>
        <li>Preparing or sending communications.</li>
        <li>Updating invoice information.</li>
        <li>Generating documents.</li>
        <li>Retrieving business performance information.</li>
      </UL>
      <P>Your use of these features is subject to the authorization and responsibility provisions of our Terms of Service.</P>

      <H3>5.4 Automated decision-making</H3>
      <P>Ivy provides informational and administrative tools intended to assist human decision-making.</P>
      <P>Ivy is not intended to independently make legally significant decisions about individuals in areas such as employment, credit eligibility, insurance eligibility, healthcare, housing, or access to essential services.</P>
      <P>Business customers remain responsible for their decisions and for complying with applicable laws governing automated decision-making and profiling.</P>
      <P>Where applicable law provides rights concerning automated decision-making or profiling, individuals may exercise those rights by contacting <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a>.</P>

      <H3>5.5 Sensitive information in AI features</H3>
      <P>You should not submit unnecessary sensitive personal information, confidential third-party information, authentication credentials, or information prohibited by our Terms of Service to artificial intelligence features.</P>
      <P>AI-generated information may be inaccurate or incomplete and should be independently reviewed before use.</P>

      <H2>6. Aggregate and De-Identified Information</H2>
      <P>We may create aggregated or appropriately de-identified information from permitted data processing activities.</P>
      <P>This may include statistics concerning:</P>
      <UL>
        <li>Platform usage.</li>
        <li>Total bookings.</li>
        <li>Aggregate payment activity.</li>
        <li>Feature adoption.</li>
        <li>Business performance trends.</li>
        <li>Customer retention.</li>
        <li>Product performance.</li>
      </UL>
      <P>We may use such information for lawful analytics, research, product improvement, business planning, and marketing purposes.</P>
      <P>Where information is represented as de-identified, we take reasonable measures designed to prevent it from being associated with an identifiable individual.</P>
      <P>We maintain and use de-identified information in de-identified form and do not attempt to re-identify it except as permitted by applicable law to evaluate de-identification safeguards.</P>
      <P>Where required, recipients of de-identified information will be subject to appropriate restrictions against re-identification.</P>
      <P>We do not publish aggregate statistics in a manner intended to identify individual customers, their businesses, or their clients without appropriate authorization.</P>

      <H2>7. How We Disclose Information</H2>
      <P>We may disclose personal information in the circumstances described below.</P>

      <H3>7.1 Service providers and subprocessors</H3>
      <P>We use third-party providers to support the operation, maintenance, security, and functionality of Ivy.</P>
      <P>These may include the following providers:</P>
      <P><strong>Vercel:</strong> Application hosting, infrastructure, and file storage.</P>
      <P><strong>Neon:</strong> Database hosting and related infrastructure.</P>
      <P><strong>Resend:</strong> Email delivery and related communications services.</P>
      <P><strong>Artificial intelligence providers:</strong> Processing AI prompts, contextual information, and responses. Information concerning our current AI provider is available upon request.</P>
      <P><strong>Stripe and Stripe Connect:</strong> Subscription billing, payment processing, transaction management, and connected payment accounts.</P>
      <P><strong>Square:</strong> Payment processing and related functionality for businesses that enable the integration.</P>
      <P><strong>PayPal:</strong> Payment processing and related functionality for businesses that enable the integration.</P>
      <P><strong>Twilio:</strong> SMS delivery, receipt, and related communications functionality.</P>
      <P><strong>Apple:</strong> App Store purchases, subscription management, application distribution, and device notifications.</P>
      <P><strong>RevenueCat:</strong> Mobile subscription management and purchase-related functionality.</P>
      <P><strong>Google:</strong> Calendar synchronization and related functionality when authorized.</P>
      <P><strong>Sentry:</strong> Error reporting, diagnostics, and application monitoring.</P>
      <P><strong>OpenStreetMap-related services:</strong> Address lookup and geographic functionality.</P>
      <P>We may update our providers as the Service evolves.</P>
      <P>Where a provider processes personal information on our behalf, we use appropriate contractual restrictions and safeguards as required by applicable law.</P>

      <H3>7.2 Independent third-party services</H3>
      <P>Certain providers, including payment processors, app stores, and connected account services, may independently determine how they process information for their own lawful purposes.</P>
      <P>These purposes may include:</P>
      <UL>
        <li>Fraud prevention.</li>
        <li>Regulatory compliance.</li>
        <li>Identity verification.</li>
        <li>Transaction processing.</li>
        <li>Account administration.</li>
        <li>Security.</li>
        <li>Legal recordkeeping.</li>
      </UL>
      <P>Such processing may be governed by the provider's own privacy policy and contractual terms.</P>

      <H3>7.3 Authorized business users</H3>
      <P>Information within a workspace may be accessible to the business that controls the workspace and individuals authorized by that business.</P>
      <P>Business customers are responsible for managing access permissions and ensuring that authorized individuals handle information appropriately.</P>

      <H3>7.4 Business clients and public-facing content</H3>
      <P>When you use Ivy to publish a website, booking page, invoice, document, or other customer-facing material, information may be disclosed to intended recipients or made publicly available according to your settings and instructions.</P>
      <P>You are responsible for reviewing information before publishing it or making it accessible to others.</P>

      <H3>7.5 Legal obligations and protection of rights</H3>
      <P>We may disclose information where reasonably necessary and legally permitted to:</P>
      <UL>
        <li>Comply with applicable law.</li>
        <li>Respond to valid subpoenas, court orders, or governmental requests.</li>
        <li>Investigate fraud or unlawful conduct.</li>
        <li>Protect the security and integrity of the Service.</li>
        <li>Protect the rights, property, or safety of Ivy, its users, or others.</li>
        <li>Establish, exercise, or defend legal claims.</li>
      </UL>

      <H3>7.6 Business transfers</H3>
      <P>Information may be disclosed or transferred in connection with an actual or proposed:</P>
      <UL>
        <li>Merger.</li>
        <li>Acquisition.</li>
        <li>Financing.</li>
        <li>Corporate restructuring.</li>
        <li>Sale of assets.</li>
        <li>Bankruptcy.</li>
        <li>Other lawful business transaction.</li>
      </UL>
      <P>Such disclosures will be subject to appropriate confidentiality protections, applicable law, and applicable contractual data protection obligations.</P>
      <P>If a business transfer results in materially different processing of personal information, we will provide notices or obtain consent where required by applicable law.</P>

      <H3>7.7 With your authorization</H3>
      <P>We may disclose information to additional parties when you expressly authorize or direct us to do so, subject to applicable law.</P>

      <H2>8. Sale of Personal Information and Advertising</H2>
      <P>Ivy does not sell personal information or Customer Data.</P>
      <P>We do not rent or trade your client lists, invoices, messages, documents, bookings, or other Customer Data to third parties for their own marketing purposes.</P>
      <P>We do not share personal information for cross-context behavioral advertising as defined under California privacy law.</P>
      <P>We do not use personal information for targeted advertising as defined under applicable state privacy laws.</P>
      <P>We do not operate third-party advertising trackers or session-replay tools as part of our current Service.</P>
      <P>We may use first-party analytics and appropriately aggregated or de-identified statistics to evaluate and market Ivy's own services.</P>
      <P>Additional information is available at:</P>
      <P><LegalLink to="/do-not-sell" style={A}>https://www.joinivy.ai/do-not-sell</LegalLink></P>
      <P>If our practices materially change, we will update this Privacy Policy and provide applicable notices, choices, and consent mechanisms before engaging in processing that requires them.</P>

      <H2>9. Google Calendar and Google User Data</H2>
      <P>If you connect your Google account or Google Calendar to Ivy, we may access information permitted by the authorization you grant.</P>
      <P>Depending on the integration's functionality and authorized permissions, this may include calendar identifiers, event information, event times, scheduling information, and other information necessary to provide the enabled calendar functionality.</P>
      <P>We use Google user data to provide and maintain authorized calendar integration features.</P>
      <P>We do not sell Google user data or use it for advertising.</P>
      <P>We do not use Google user data to develop, improve, or train generalized artificial intelligence or machine learning models.</P>
      <P>Our use and transfer of information received from Google APIs will adhere to the Google API Services User Data Policy, including its Limited Use requirements, where applicable.</P>
      <P>Information obtained through Google APIs will not be transferred to third parties except as permitted by applicable Google policies and necessary to provide authorized functionality, maintain security, comply with applicable law, or otherwise as expressly permitted.</P>
      <P>Human access to Google user data is restricted in accordance with applicable Google policies.</P>
      <P>You may revoke Ivy's access through your Google account permissions or available integration settings.</P>
      <P>Revoking access prevents future authorized retrieval of Google user data but does not necessarily immediately remove information previously synchronized or retained in accordance with applicable law and this Privacy Policy.</P>

      <H2>10. Email, SMS, and Notifications</H2>

      <H3>10.1 Service-related communications</H3>
      <P>We may send communications necessary to operate and administer the Service, including:</P>
      <UL>
        <li>Account verification.</li>
        <li>Password resets.</li>
        <li>Security alerts.</li>
        <li>Subscription and billing notices.</li>
        <li>Data retention and deletion notices.</li>
        <li>Important service announcements.</li>
        <li>Responses to support requests.</li>
        <li>Other necessary administrative communications.</li>
      </UL>
      <P>Certain essential service communications cannot be disabled while maintaining an active account.</P>

      <H3>10.2 Marketing communications</H3>
      <P>Where applicable, we provide choices concerning marketing emails and other promotional communications.</P>
      <P>You may unsubscribe using the unsubscribe mechanism included in marketing communications or available account settings.</P>
      <P>Opting out of marketing communications does not prevent us from sending necessary service-related communications.</P>

      <H3>10.3 Communications from businesses using Ivy</H3>
      <P>Businesses may use Ivy to communicate with their clients through email, SMS, and other supported communication channels.</P>
      <P>Those businesses are responsible for obtaining legally required consent and complying with applicable communications laws.</P>
      <P>Where supported, recipients may reply STOP to applicable SMS messages to revoke consent or use available unsubscribe mechanisms.</P>
      <P>We may process communication preferences, consent records, delivery information, and opt-out requests to provide functionality and support compliance.</P>
      <P>If you receive an unauthorized communication through Ivy, you may report it to <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a>.</P>

      <H3>10.4 Mobile information</H3>
      <P>Mobile phone numbers and SMS opt-in information collected for messaging purposes will not be sold or shared with third parties or affiliates for their own marketing or promotional purposes.</P>
      <P>SMS consent information may be disclosed to service providers involved in delivering messages, maintaining messaging functionality, or complying with applicable legal obligations.</P>

      <H2>11. Cookies, Local Storage, and Device Information</H2>
      <P>Ivy uses cookies and similar technologies necessary to provide and maintain the Service.</P>
      <P>These may include:</P>
      <UL>
        <li>Authentication and session cookies.</li>
        <li>Security-related storage.</li>
        <li>Account and application preferences.</li>
        <li>First-party analytics.</li>
        <li>Local device storage.</li>
        <li>Technical functionality necessary for the Service.</li>
      </UL>
      <P>We use session cookies to maintain authenticated access and apply appropriate security attributes where supported.</P>
      <P>Our first-party analytics help us understand feature usage, platform performance, and customer experience.</P>
      <P>We do not currently use third-party advertising cookies or session-replay technologies.</P>
      <P>The Ivy mobile application may store certain information locally on your device, including portions of your schedule and client information, to support offline functionality.</P>
      <P>Information stored on your device may remain there until removed through application functionality, device settings, application removal, or other applicable mechanisms.</P>
      <P>You are responsible for maintaining appropriate security on devices used to access business and client information.</P>
      <P>You may manage cookies through your browser settings. Disabling necessary cookies may prevent portions of the Service from functioning correctly.</P>

      <H2>12. Do Not Track and Global Privacy Control</H2>
      <P>Some browsers provide Do Not Track signals or other privacy preference mechanisms.</P>
      <P>Because there is no universally adopted standard for responding to traditional Do Not Track signals, Ivy does not currently respond to those signals in a uniform manner.</P>
      <P>Where required by applicable law, Ivy will recognize and honor legally recognized opt-out preference signals, including Global Privacy Control, for processing activities to which those requirements apply.</P>
      <P>Ivy does not currently sell personal information, share personal information for cross-context behavioral advertising, or process personal information for targeted advertising.</P>

      <H2>13. Data Retention</H2>
      <P>We retain personal information for periods reasonably necessary to provide the Service, fulfill the purposes described in this Privacy Policy, comply with applicable law, and maintain legitimate security and operational requirements.</P>
      <P>Retention periods depend on the nature of the information and the purposes for which it is processed.</P>

      <H3>13.1 Active accounts</H3>
      <P>We generally retain workspace information while your subscription or authorized account remains active.</P>
      <P>You may remove individual records using available Service functionality, subject to applicable retention requirements and technical limitations.</P>

      <H3>13.2 Expired paid subscriptions</H3>
      <P>When your paid subscription ends, including following cancellation or unresolved payment failure, we generally retain your workspace information for seven days following the applicable subscription expiration date.</P>
      <P>During this period, you may export available workspace information or resubscribe.</P>
      <P>Your website, booking page, and client portal may be archived during this period.</P>
      <P>We generally send an email when the seven-day retention period begins and another reminder approximately two days before scheduled deletion.</P>
      <P>Unless you resubscribe before the applicable deadline, workspace information is scheduled for deletion following the retention period, subject to the exceptions described below.</P>

      <H3>13.3 Expired free trials</H3>
      <P>If your free trial ends without an active paid subscription, we generally retain workspace information for four weeks following trial expiration.</P>
      <P>We provide applicable deletion notices and an opportunity to export available information.</P>
      <P>Following this period, workspace information is scheduled for deletion unless you subscribe or another lawful retention requirement applies.</P>

      <H3>13.4 Account deletion</H3>
      <P>You may request account deletion through Account Settings or by contacting <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a>.</P>
      <P>We generally complete account deletion requests within 30 days, subject to applicable law, identity verification, and permitted retention exceptions.</P>
      <P>Where applicable law establishes a different response or completion deadline, we will comply with that requirement.</P>

      <H3>13.5 Backups</H3>
      <P>Information removed from active production systems may remain temporarily within restricted backup systems.</P>
      <P>Backups may persist for up to 30 additional days before being overwritten or removed through ordinary backup rotation.</P>
      <P>Backup information remains subject to applicable security and confidentiality safeguards.</P>
      <P>Information retained solely within backups is not ordinarily used for active business operations.</P>

      <H3>13.6 Operational logs</H3>
      <P>Operational and server logs are generally retained for up to 30 days.</P>
      <P>Certain security-related information may be retained longer where reasonably necessary to investigate fraud, security incidents, abuse, or legal claims.</P>

      <H3>13.7 Billing and legal records</H3>
      <P>We may retain transaction records, invoices, tax records, subscription history, and other legally relevant information for periods required or permitted by applicable law.</P>
      <P>Retention periods depend on applicable accounting, taxation, regulatory, and legal requirements.</P>

      <H3>13.8 Fraud and trial abuse prevention</H3>
      <P>To prevent repeated free-trial abuse, we may retain a hashed representation of an email address following account deletion.</P>
      <P>This information is used to recognize previously registered email addresses without retaining the original email address in readable form for that purpose.</P>
      <P>We retain such information only for as long as reasonably necessary for legitimate fraud or abuse prevention purposes, subject to applicable law.</P>
      <P>Hashed information is treated as personal information where applicable law requires.</P>

      <H3>13.9 Other retention exceptions</H3>
      <P>We may retain limited information where reasonably necessary or legally permitted for:</P>
      <UL>
        <li>Compliance with legal obligations.</li>
        <li>Security and fraud prevention.</li>
        <li>Abuse investigations.</li>
        <li>Moderation records.</li>
        <li>Dispute resolution.</li>
        <li>Enforcement of agreements.</li>
        <li>Establishing or defending legal claims.</li>
        <li>Maintaining legally required records.</li>
        <li>Protecting the rights and safety of users and others.</li>
      </UL>
      <P>Information retained under an exception remains subject to applicable privacy and security obligations.</P>

      <H3>13.10 Third-party retention</H3>
      <P>Third-party providers acting independently may retain information according to their own legal obligations and privacy practices.</P>
      <P>Deleting information from Ivy does not necessarily delete information independently maintained by a payment processor, connected account provider, recipient of a communication, or other independent third party.</P>

      <H2>14. Data Security</H2>
      <P>We maintain administrative, technical, and organizational safeguards designed to protect personal information against unauthorized access, disclosure, alteration, loss, and misuse.</P>
      <P>Our safeguards include, as appropriate:</P>
      <UL>
        <li>Password hashing.</li>
        <li>Encryption of information in transit using TLS.</li>
        <li>Authentication and authorization controls.</li>
        <li>Workspace-level access restrictions.</li>
        <li>Protected authentication and verification tokens.</li>
        <li>Restricted access to production information.</li>
        <li>Security monitoring and abuse prevention measures.</li>
      </UL>
      <P>We use bcrypt for password hashing and SHA-256 hashing for applicable authentication and verification tokens.</P>
      <P>Our systems are designed to restrict access to workspace information to authorized users, personnel, and service providers.</P>
      <P>No method of electronic transmission, storage, or software operation can be guaranteed to be completely secure.</P>
      <P>You are responsible for protecting your account credentials, managing authorized access, and maintaining appropriate device security.</P>
      <P>If you believe your account or personal information has been compromised, contact <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a> promptly.</P>
      <P>We will provide security incident notifications to affected individuals, business customers, and governmental authorities where required by applicable law or contractual obligations.</P>

      <H2>15. Geographic Location and International Transfers</H2>
      <P>Ivy is operated by Ivy AI LLC in the United States.</P>
      <P>Our primary database infrastructure is hosted in the United States. Our email and AI processing arrangements are primarily based in the United States.</P>
      <P>We may use distributed infrastructure and edge computing services in other geographic regions, including Europe and Asia-Pacific, to support application performance and availability.</P>
      <P>Although our primary persistent storage is located in the United States, information may be processed or accessed in other jurisdictions depending on service providers, connected integrations, technical infrastructure, and authorized operational activities.</P>
      <P>Privacy and data protection laws in those jurisdictions may differ from the laws of your jurisdiction.</P>
      <P>Where applicable law requires safeguards for international transfers, we will use appropriate lawful transfer mechanisms, which may include applicable Standard Contractual Clauses or other recognized safeguards.</P>
      <P>Additional information concerning applicable international transfer safeguards may be requested at <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a>.</P>

      <H2>16. Privacy Rights and Choices</H2>
      <P>Depending on your jurisdiction and applicable law, you may have rights concerning your personal information.</P>
      <P>These may include the following:</P>

      <H3>16.1 Right to access</H3>
      <P>You may request confirmation of whether we process personal information about you and request access to applicable information.</P>
      <P>Available workspace information may also be exported through Account Settings.</P>

      <H3>16.2 Right to correction</H3>
      <P>You may request correction of inaccurate personal information.</P>
      <P>Certain information may be corrected directly through your account.</P>

      <H3>16.3 Right to deletion</H3>
      <P>You may request deletion of personal information, subject to applicable legal exceptions.</P>

      <H3>16.4 Right to data portability</H3>
      <P>Where applicable, you may request a copy of personal information in a reasonably accessible and portable format.</P>

      <H3>16.5 Right to opt out</H3>
      <P>Depending on applicable law, you may have the right to opt out of:</P>
      <UL>
        <li>The sale of personal information.</li>
        <li>Sharing for cross-context behavioral advertising.</li>
        <li>Targeted advertising.</li>
        <li>Certain profiling activities in furtherance of decisions producing legal or similarly significant effects.</li>
      </UL>
      <P>Ivy does not currently sell personal information or engage in cross-context behavioral advertising or targeted advertising.</P>

      <H3>16.6 Sensitive personal information rights</H3>
      <P>Where applicable, you may have rights to limit certain uses or disclosures of sensitive personal information or withdraw consent to its processing.</P>

      <H3>16.7 Right to withdraw consent</H3>
      <P>Where processing is based on your consent, you may withdraw that consent, subject to applicable law.</P>
      <P>Withdrawal does not affect the lawfulness of processing that occurred before consent was withdrawn.</P>

      <H3>16.8 Right to nondiscrimination</H3>
      <P>We will not unlawfully discriminate against you for exercising applicable privacy rights.</P>
      <P>Certain information may be necessary to provide specific functionality. If you request deletion or restrict processing of that information, we may be unable to provide the affected functionality.</P>

      <H3>16.9 Right to appeal</H3>
      <P>Where applicable law provides an appeal right, you may appeal a decision denying your privacy request by contacting <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a> with the subject line "Privacy Rights Appeal."</P>
      <P>We will review and respond to appeals within applicable statutory deadlines.</P>
      <P>Where required, we will provide information concerning how to contact the relevant governmental authority if an appeal is denied.</P>

      <H2>17. Exercising Your Privacy Rights</H2>
      <P>You may submit privacy requests through available Account Settings or by emailing:</P>
      <P><a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a></P>
      <P>Please provide sufficient information to allow us to identify your request and locate relevant information.</P>
      <P>We may take reasonable steps to verify your identity and authority before fulfilling a request.</P>
      <P>Verification may include confirming your account information, email address, or other information reasonably necessary to protect against unauthorized disclosure or deletion.</P>
      <P>We will not require unnecessary information for verification.</P>
      <P>Where applicable law permits an authorized agent to submit a request on your behalf, we may require reasonable evidence of the agent's authority and verification of your identity.</P>
      <P>We will respond within the time required by applicable law.</P>
      <P>We may deny or limit requests where legally permitted, including where information must be retained for legal obligations, security, fraud prevention, or the protection of another person's rights.</P>
      <P>If we deny a request, we will provide applicable explanations and appeal information as required by law.</P>

      <H2>18. California Privacy Disclosures</H2>
      <P>This section supplements the remainder of this Privacy Policy for California residents.</P>
      <P>Certain rights and obligations described in this section apply where Ivy is subject to the California Consumer Privacy Act, as amended by the California Privacy Rights Act ("CCPA"), or other applicable California privacy laws.</P>

      <H3>18.1 Categories of personal information</H3>
      <P>Depending on your interaction with the Service, the categories of personal information we collect may include:</P>
      <UL>
        <li>Identifiers, including names, email addresses, phone numbers, account identifiers, and IP addresses.</li>
        <li>Customer records information, including contact information and business-related records.</li>
        <li>Commercial information, including subscriptions, transaction history, purchases, invoices, and payment activity.</li>
        <li>Internet or electronic network activity, including application usage, interactions, device information, and operational logs.</li>
        <li>Approximate geographic information derived from IP addresses and business location information.</li>
        <li>Professional or employment-related information provided through business profiles and workspace records.</li>
        <li>Electronic communications, documents, and other content submitted to the Service.</li>
        <li>Inferences concerning product usage, business activity, and service preferences.</li>
        <li>Sensitive personal information, to the extent collected, including account authentication information and information voluntarily submitted within authorized functionality.</li>
      </UL>
      <P>The categories collected depend on the features used and the information provided.</P>

      <H3>18.2 Sources and purposes</H3>
      <P>We collect personal information from the sources described in Section 3.</P>
      <P>We use personal information for the business and commercial purposes described in Sections 4 through 6.</P>

      <H3>18.3 Disclosures for business purposes</H3>
      <P>We may disclose the applicable categories of personal information described above to:</P>
      <UL>
        <li>Hosting and infrastructure providers.</li>
        <li>Database providers.</li>
        <li>AI service providers.</li>
        <li>Communications providers.</li>
        <li>Payment processors.</li>
        <li>App stores and subscription management providers.</li>
        <li>Security and diagnostic providers.</li>
        <li>Authorized business customers and workspace users.</li>
        <li>Connected integration providers.</li>
        <li>Governmental authorities or other recipients where legally required or permitted.</li>
        <li>Parties involved in lawful business transfers.</li>
      </UL>
      <P>Disclosures are limited according to the applicable purposes, contractual arrangements, and legal requirements described in this Privacy Policy.</P>

      <H3>18.4 Sale and sharing</H3>
      <P>Ivy does not sell personal information or share personal information for cross-context behavioral advertising.</P>
      <P>We do not knowingly sell or share personal information of individuals under 16 years of age.</P>
      <P>Information concerning these practices is available at:</P>
      <P><LegalLink to="/do-not-sell" style={A}>https://www.joinivy.ai/do-not-sell</LegalLink></P>

      <H3>18.5 Sensitive personal information</H3>
      <P>We use sensitive personal information, where collected, for authorized Service functionality, account security, authentication, fraud prevention, and other purposes permitted by applicable law.</P>
      <P>We do not use sensitive personal information to infer characteristics about individuals for unrelated advertising purposes.</P>
      <P>Where applicable law provides a right to limit the use or disclosure of sensitive personal information, you may exercise that right by contacting us.</P>

      <H3>18.6 Retention</H3>
      <P>Our retention periods and criteria are described in Section 13.</P>
      <P>We do not retain personal information longer than reasonably necessary for the applicable purposes, subject to legally permitted retention requirements.</P>

      <H3>18.7 California privacy rights</H3>
      <P>Where applicable, California residents may exercise rights to:</P>
      <UL>
        <li>Know what personal information we collect, use, and disclose.</li>
        <li>Access specific pieces and categories of personal information.</li>
        <li>Request deletion.</li>
        <li>Request correction.</li>
        <li>Opt out of sale or sharing.</li>
        <li>Limit certain uses of sensitive personal information.</li>
        <li>Receive nondiscriminatory treatment for exercising privacy rights.</li>
      </UL>
      <P>Requests may be submitted using the methods described in Section 17.</P>

      <H3>18.8 California direct marketing disclosures</H3>
      <P>Ivy does not disclose personal information to third parties for their own direct marketing purposes as contemplated by California Civil Code Section 1798.83.</P>
      <P>California residents may contact <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a> with questions concerning these practices.</P>

      <H2>19. Additional United States Privacy Rights</H2>
      <P>Residents of certain United States jurisdictions may have additional rights under applicable state privacy laws.</P>
      <P>Depending on the jurisdiction, the nature of the information, and whether the applicable law covers Ivy's processing activities, these rights may include:</P>
      <UL>
        <li>Access to personal information.</li>
        <li>Confirmation of processing.</li>
        <li>Correction of inaccurate information.</li>
        <li>Deletion of personal information.</li>
        <li>Data portability.</li>
        <li>Opting out of targeted advertising.</li>
        <li>Opting out of personal information sales.</li>
        <li>Opting out of certain profiling activities.</li>
        <li>Withdrawing consent to certain sensitive information processing.</li>
        <li>Obtaining information concerning certain third-party disclosures.</li>
        <li>Appealing denied privacy requests.</li>
      </UL>
      <P>We will honor applicable rights in accordance with the requirements of the relevant law.</P>
      <P>Privacy rights may be subject to statutory exceptions, verification requirements, and limitations.</P>
      <P>Requests and appeals may be submitted to <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a>.</P>

      <H2>20. European Economic Area, United Kingdom, and Other International Rights</H2>
      <P>Where the General Data Protection Regulation ("GDPR"), UK GDPR, or other international privacy laws apply, individuals may have additional rights and protections.</P>

      <H3>20.1 Lawful bases for processing</H3>
      <P>Where required, we process personal information based on one or more applicable lawful grounds, including:</P>
      <UL>
        <li>Performance of a contract.</li>
        <li>Steps requested before entering into a contract.</li>
        <li>Compliance with legal obligations.</li>
        <li>Legitimate interests, where not overridden by applicable individual rights.</li>
        <li>Consent.</li>
        <li>Other lawful grounds permitted by applicable law.</li>
      </UL>
      <P>Our legitimate interests may include operating, securing, improving, and supporting the Service, preventing fraud, and managing our business.</P>

      <H3>20.2 Additional rights</H3>
      <P>Where applicable, you may have the right to:</P>
      <UL>
        <li>Access personal information.</li>
        <li>Correct inaccurate information.</li>
        <li>Request erasure.</li>
        <li>Restrict processing.</li>
        <li>Object to processing.</li>
        <li>Receive portable copies of information.</li>
        <li>Withdraw consent.</li>
        <li>Exercise applicable rights concerning automated decision-making.</li>
        <li>Lodge a complaint with a competent data protection authority.</li>
      </UL>
      <P>These rights may be subject to applicable legal limitations and exceptions.</P>

      <H3>20.3 Supervisory authorities</H3>
      <P>Individuals may have the right to lodge a complaint with the data protection authority responsible for their jurisdiction.</P>
      <P>We encourage you to contact <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a> if you have questions or concerns regarding our processing activities.</P>

      <H2>21. If You Are a Client of a Business Using Ivy</H2>
      <P>If your information was submitted to Ivy by a business, or collected through a business's Ivy-powered website, booking page, invoice, or client portal, that business generally determines how your information is used.</P>
      <P>Requests concerning that business's records should ordinarily be directed to the business.</P>
      <P>This may include requests to:</P>
      <UL>
        <li>Access client records.</li>
        <li>Correct contact information.</li>
        <li>Delete appointment history.</li>
        <li>Remove communications.</li>
        <li>Update marketing preferences.</li>
        <li>Withdraw consent.</li>
      </UL>
      <P>You may also contact <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a>.</P>
      <P>Where Ivy acts solely as a processor or service provider, we may refer your request to the relevant business and provide assistance consistent with our contractual and legal obligations.</P>
      <P>Where Ivy independently controls the relevant information, we will handle the request directly as required by applicable law.</P>

      <H2>22. Children's Privacy</H2>
      <P>Ivy accounts and subscriptions are intended for individuals who are at least 18 years old or the applicable age of majority, if higher.</P>
      <P>The Service is not directed to children under 13 years of age, and we do not knowingly collect personal information directly from children under 13 in circumstances requiring parental consent without obtaining such consent as required by law.</P>
      <P>Businesses using Ivy may independently interact with minors through their own business activities.</P>
      <P>Business customers are responsible for determining whether they may lawfully collect and process information concerning minors, providing required notices, obtaining parental or guardian consent where necessary, and complying with applicable children's privacy laws.</P>
      <P>Business customers must not use Ivy in a manner that violates the Children's Online Privacy Protection Act or other applicable laws protecting minors.</P>
      <P>If we become aware that personal information has been collected unlawfully from a child, we will take appropriate steps to remove or restrict the information as required by applicable law.</P>
      <P>Parents or guardians who believe a child's information has been collected improperly may contact <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a>.</P>

      <H2>23. Healthcare and Sensitive Information</H2>
      <P>Ivy is not a HIPAA-compliant platform and does not offer Business Associate Agreements.</P>
      <P>The Service is not designed or authorized for processing protected health information subject to HIPAA.</P>
      <P>You must not submit information prohibited by our Terms of Service, including unauthorized medical records, clinical treatment notes, highly sensitive consumer health information, or other restricted categories of information.</P>
      <P>Businesses are responsible for determining whether their use of Ivy complies with applicable healthcare, consumer health privacy, professional licensing, and other specialized regulatory requirements.</P>
      <P>Ivy does not intentionally collect consumer health information for independent health profiling, health-related advertising, or the sale of health information.</P>
      <P>If we become aware of information being processed in violation of our Terms of Service or applicable law, we may restrict processing, remove information, suspend affected functionality, or take other appropriate action.</P>

      <H2>24. Third-Party Websites and Services</H2>
      <P>The Service may contain links to or integrations with websites, applications, payment services, and other services operated by third parties.</P>
      <P>This Privacy Policy does not govern the independent privacy practices of those third parties.</P>
      <P>We encourage you to review the applicable privacy policies before providing information to or authorizing access by third-party services.</P>
      <P>Connecting a third-party account may permit information to be exchanged between Ivy and that service according to your authorization and the applicable integration functionality.</P>
      <P>You may revoke available integration permissions through Ivy or the relevant third-party service.</P>

      <H2>25. Changes to This Privacy Policy</H2>
      <P>We may update this Privacy Policy as our services, processing activities, technology, and legal obligations evolve.</P>
      <P>The updated policy will identify its revision or effective date.</P>
      <P>For material changes, we will provide appropriate advance notice through email, in-app notifications, or another reasonable communication mechanism.</P>
      <P>We generally provide at least 14 days' advance notice of material changes, except where a shorter period is required by law or reasonably necessary to address urgent legal or security requirements.</P>
      <P>Where applicable law requires consent for new or materially different processing activities, we will obtain that consent before engaging in the relevant processing.</P>
      <P>Your acknowledgment of this Privacy Policy does not constitute blanket consent to all processing activities or waive applicable privacy rights.</P>
      <P>Where continued use of particular functionality requires additional authorization, we may request that authorization separately.</P>
      <P>If you do not agree with changes affecting your use of the Service, you may discontinue use, cancel your subscription, request applicable data exports, or request account deletion.</P>

      <H2>26. Contact Information</H2>
      <P>Ivy is operated by:</P>
      <P>Ivy AI LLC</P>
      <P>California, United States</P>
      <P>Privacy inquiries and privacy rights requests:</P>
      <P><a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a></P>
      <P>General support:</P>
      <P><a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a></P>
      <P>Website:</P>
      <P><a href="https://joinivy.ai" style={A}>https://joinivy.ai</a></P>
      <P>Terms of Service:</P>
      <P><LegalLink to="/terms" style={A}>https://joinivy.ai/terms</LegalLink></P>
      <P>Do Not Sell or Share:</P>
      <P><LegalLink to="/do-not-sell" style={A}>https://www.joinivy.ai/do-not-sell</LegalLink></P>
      <P>We will review privacy inquiries and respond in accordance with applicable legal requirements.</P>
    </>
  );
}
