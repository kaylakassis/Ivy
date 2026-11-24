// /terms - public Terms of Service.
//
// The text below is the owner's own, put in word for word as supplied on
// 2026-11-24 (37 sections). Do not reword it: a change to what it says is
// hers (and her lawyer's) to make. tests/terms-update.test.mjs compares
// this page with the supplied text, so an accidental edit fails the build.
//
// Bumping the version: change CURRENT_TERMS_VERSION in api/_lib/legal.js
// (+ the mirror in src/lib/legal.js) and TERMS_VERSION below to match, and
// add the outgoing version to PRIOR_TERMS_VERSIONS. Existing users are then
// asked to accept (src/components/TermsAcceptModal.jsx).
import React from 'react';
import LegalPage, { H2, H3, P, UL } from './LegalPage.jsx';
import LegalLink from '../../components/LegalLink.jsx';

export const TERMS_VERSION = '2026-11-24';
export const TERMS_LAST_UPDATED = 'November 24, 2026';
export const TERMS_EFFECTIVE = 'December 8, 2026';

const A = { color: 'var(--accent)' };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" lastUpdated={TERMS_LAST_UPDATED} effectiveDate={TERMS_EFFECTIVE} path="/terms"
      description="The Terms of Service that govern your access to and use of Ivy, including its websites, mobile applications, booking pages and client portals.">
      <P>These Terms of Service ("Terms") govern your access to and use of Ivy, including its websites, mobile applications, artificial intelligence features, software, integrations, booking pages, client portals, communications, and related services (collectively, the "Service").</P>
      <P>The Service is owned and operated by Ivy AI LLC ("Ivy," "Company," "we," "us," or "our").</P>
      <P>By affirmatively accepting these Terms, creating an account after being presented with these Terms and agreeing to them, or otherwise expressly agreeing to these Terms, you enter into a legally binding agreement with Ivy AI LLC.</P>
      <P>If you do not agree to these Terms, you may not access or use the Service.</P>
      <P><strong>PLEASE READ THESE TERMS CAREFULLY. THEY INCLUDE IMPORTANT PROVISIONS REGARDING LIMITATIONS OF LIABILITY, ARTIFICIAL INTELLIGENCE, INDEMNIFICATION, AUTOMATIC SUBSCRIPTION RENEWALS, AND DISPUTE RESOLUTION, INCLUDING BINDING ARBITRATION AND A CLASS-ACTION WAIVER, SUBJECT TO APPLICABLE LAW.</strong></P>

      <H2>1. Eligibility and Account Responsibilities</H2>
      <P>You must be at least 18 years old, or the age of majority in your jurisdiction if higher, and legally capable of entering into a binding agreement to create an account or subscribe to the Service.</P>
      <P>If you use the Service on behalf of a business, organization, or other legal entity, you represent that you have the authority to bind that entity to these Terms. References to "you" include both you and the entity you represent, as applicable.</P>
      <P>You agree to:</P>
      <UL>
        <li>Provide accurate, complete, and current account information.</li>
        <li>Maintain the confidentiality and security of your account credentials.</li>
        <li>Restrict access to your account to authorized individuals.</li>
        <li>Maintain appropriate permissions for individuals accessing your workspace.</li>
        <li>Promptly notify Ivy of suspected unauthorized access or security incidents.</li>
        <li>Take reasonable steps to prevent unauthorized use of your account.</li>
      </UL>
      <P>You are responsible for activities conducted through your account by you and individuals you authorize, subject to applicable law and Ivy's responsibility for its own conduct.</P>
      <P>Notify us immediately at <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a> if you suspect unauthorized access.</P>

      <H2>2. Nature of the Service</H2>
      <P>Ivy provides software tools intended to assist businesses with administrative, operational, organizational, and informational activities.</P>
      <P>The Service may include artificial intelligence, client management, scheduling, invoicing, payment integrations, business analytics, website publishing, document management, communications, and other business management functionality.</P>
      <P>Ivy is a technology provider. Ivy is not your employee, business partner, fiduciary, financial institution, payment processor, legal representative, or licensed advisor.</P>
      <P>Except for the limited authorization necessary to perform actions you request through the Service, nothing in these Terms creates an agency, partnership, joint venture, employment, franchise, or fiduciary relationship between you and Ivy.</P>
      <P>You retain responsibility for operating your business, complying with applicable laws, maintaining required licenses and insurance, and making independent business decisions.</P>

      <H2>3. No Professional Advice</H2>
      <P><strong>THE SERVICE IS PROVIDED FOR INFORMATIONAL, ADMINISTRATIVE, AND BUSINESS MANAGEMENT PURPOSES ONLY.</strong></P>
      <P>Nothing provided through the Service constitutes legal, financial, investment, accounting, tax, medical, psychological, insurance, or other licensed professional advice.</P>
      <P>This limitation applies to all features and outputs of the Service, including:</P>
      <UL>
        <li>Artificial intelligence responses.</li>
        <li>Business recommendations.</li>
        <li>Dashboard metrics and financial summaries.</li>
        <li>Suggested pricing and marketing strategies.</li>
        <li>Generated documents and agreements.</li>
        <li>Emails and other communications.</li>
        <li>Reports, forecasts, and calculations.</li>
        <li>Automated actions and third-party integrations.</li>
      </UL>
      <P>Ivy does not represent that any information, document, recommendation, or output is appropriate for your particular circumstances or compliant with applicable laws.</P>
      <P>You are responsible for independently reviewing and verifying information before relying on it.</P>
      <P>You should consult an appropriately licensed attorney, accountant, tax advisor, financial advisor, or other qualified professional before making material decisions based on information obtained through the Service.</P>
      <P>Your use of the Service does not establish any attorney-client, accountant-client, advisor-client, healthcare provider-patient, or other privileged professional relationship.</P>

      <H2>4. Artificial Intelligence Features</H2>

      <H3>4.1 Nature and limitations of AI</H3>
      <P>The Service incorporates artificial intelligence and large language models that generate responses and perform certain functions based on statistical inference, available information, and user instructions.</P>
      <P>AI-generated output may be inaccurate, incomplete, misleading, outdated, biased, inappropriate, or otherwise unsuitable, even when presented confidently.</P>
      <P>Ivy does not guarantee the accuracy, completeness, originality, reliability, legality, or suitability of AI-generated output.</P>
      <P>You acknowledge that artificial intelligence is not a substitute for independent human judgment.</P>

      <H3>4.2 Responsibility for AI output</H3>
      <P>You are responsible for reviewing, verifying, and determining whether to use AI-generated output.</P>
      <P>You must not rely exclusively on AI-generated output when making decisions that could materially affect finances, legal rights, health, safety, employment, regulatory compliance, or the rights of another person.</P>
      <P>Documents, messages, emails, recommendations, and other materials generated with Ivy become your communications when you approve, publish, distribute, or send them.</P>
      <P>You are responsible for ensuring that such materials are accurate, lawful, appropriate, and suitable for their intended purpose.</P>

      <H3>4.3 AI-assisted actions and automation</H3>
      <P>Certain AI features may interact with tools and perform actions within your workspace or connected services.</P>
      <P>These actions may include, without limitation:</P>
      <UL>
        <li>Creating or updating client records.</li>
        <li>Sending communications.</li>
        <li>Creating or modifying appointments.</li>
        <li>Updating invoices and payment statuses.</li>
        <li>Generating documents.</li>
        <li>Retrieving business information.</li>
        <li>Performing other supported administrative functions.</li>
      </UL>
      <P>By requesting an action or enabling an automation, you authorize Ivy to process the information and perform the actions reasonably necessary to carry out your instructions within the applicable permissions.</P>
      <P>You represent that you have the authority to authorize those actions.</P>
      <P>AI systems may misunderstand instructions, generate unintended results, perform incomplete actions, or otherwise behave unexpectedly.</P>
      <P>You are responsible for reviewing requested actions, monitoring enabled automations, verifying completed actions, and promptly addressing unintended results.</P>
      <P>Where confirmation or approval controls are provided, you are responsible for using them appropriately.</P>
      <P>Ivy does not guarantee that an action can be reversed, recalled, corrected, or canceled after execution.</P>
      <P>Nothing in this section excludes liability that cannot lawfully be excluded or transfers responsibility for Ivy's own unlawful conduct to you.</P>

      <H3>4.4 AI usage allowances</H3>
      <P>Each workspace includes 600 Ivy assistant messages per calendar month, counted per message you send.</P>
      <P>Unused messages do not roll over.</P>
      <P>Ivy may impose reasonable usage limits, rate limits, or technical restrictions to maintain service reliability, prevent abuse, and manage operating costs.</P>
      <P>If we materially reduce your included message allowance, we will provide advance notice through the Service or by email.</P>

      <H3>4.5 AI-generated content rights</H3>
      <P>As between you and Ivy, and to the extent permitted by applicable law and third-party rights, you may use AI-generated output produced for you through your authorized use of the Service.</P>
      <P>Ivy does not guarantee that AI-generated output qualifies for copyright or other intellectual property protection, is unique to you, or does not resemble material generated for another user.</P>
      <P>You are responsible for evaluating whether your use of AI-generated output infringes another person's rights or violates applicable law.</P>
      <P>This provision does not transfer ownership of Ivy's underlying software, models, prompts, instructions, templates, proprietary technology, or other intellectual property.</P>

      <H2>5. Business Outcomes and No Guarantees</H2>
      <P>Ivy does not guarantee any particular business, financial, operational, or commercial outcome.</P>
      <P>Without limitation, Ivy does not guarantee that using the Service will:</P>
      <UL>
        <li>Increase revenue or profitability.</li>
        <li>Attract or retain clients.</li>
        <li>Reduce cancellations or missed appointments.</li>
        <li>Improve marketing performance.</li>
        <li>Reduce expenses.</li>
        <li>Improve tax outcomes.</li>
        <li>Ensure legal or regulatory compliance.</li>
        <li>Prevent fraud, payment disputes, or chargebacks.</li>
        <li>Produce accurate financial forecasts.</li>
        <li>Improve business valuation or performance.</li>
      </UL>
      <P>Business outcomes depend on numerous factors outside Ivy's control.</P>
      <P>Any examples, projections, estimates, testimonials, or aggregate statistics are illustrative and do not constitute guarantees of future results.</P>

      <H2>6. Healthcare and Sensitive Information</H2>
      <P>Ivy is not a HIPAA-compliant platform and does not offer Business Associate Agreements.</P>
      <P>The Service is not designed or authorized for creating, receiving, maintaining, processing, or transmitting protected health information ("PHI") in circumstances subject to the Health Insurance Portability and Accountability Act and its implementing regulations.</P>
      <P>You must not use the Service to store or process PHI subject to HIPAA.</P>
      <P>Unless expressly authorized by Ivy in writing, you must not use the Service to store or process:</P>
      <UL>
        <li>Medical records or clinical treatment notes.</li>
        <li>Highly sensitive consumer health information.</li>
        <li>Genetic or biometric identification data.</li>
        <li>Social Security numbers or comparable government identification numbers.</li>
        <li>Full payment card numbers or card security codes outside approved payment integrations.</li>
        <li>Passwords or authentication credentials belonging to other services, except through authorized integration mechanisms.</li>
        <li>Other information subject to specialized regulatory requirements that the Service is not designed to satisfy.</li>
      </UL>
      <P>If you operate a healthcare, wellness, fitness, mental health, or other regulated business, you are responsible for determining whether your intended use of Ivy complies with applicable privacy, licensing, recordkeeping, and consumer protection requirements.</P>
      <P>Ivy does not represent that the Service satisfies industry-specific regulatory requirements.</P>

      <H2>7. Third-Party Services and Integrations</H2>
      <P>The Service may integrate with or rely upon third-party providers, including artificial intelligence providers, payment processors, hosting providers, database providers, communications providers, app stores, analytics and error-monitoring providers, and calendar services.</P>
      <P>These may include:</P>
      <UL>
        <li>Stripe and Stripe Connect.</li>
        <li>Square.</li>
        <li>PayPal.</li>
        <li>Twilio.</li>
        <li>Google.</li>
        <li>Resend.</li>
        <li>Vercel.</li>
        <li>Neon.</li>
        <li>Apple.</li>
        <li>RevenueCat.</li>
        <li>Sentry.</li>
        <li>OpenStreetMap.</li>
        <li>Third-party artificial intelligence providers.</li>
      </UL>
      <P>Additional information concerning data processing and service providers is available in our Privacy Policy.</P>
      <P>Third-party services may be governed by their own terms, privacy policies, fees, restrictions, and eligibility requirements.</P>
      <P>By connecting a third-party account, you authorize Ivy to access and exchange information with that service as reasonably necessary to provide the functionality you enable, subject to the permissions granted and applicable law.</P>
      <P>You are responsible for maintaining your third-party accounts, reviewing applicable terms, and ensuring that you are authorized to connect those accounts.</P>
      <P>Third-party services may change, suspend, restrict, or discontinue their functionality.</P>
      <P>To the maximum extent permitted by law, Ivy is not responsible for losses caused solely by third-party services, including their outages, independent security incidents, pricing changes, account restrictions, or discontinuation.</P>
      <P>Nothing in this section limits Ivy's obligations concerning its own processing of personal information or its own conduct under applicable law.</P>

      <H2>8. Payments, Invoices, and Merchant Responsibilities</H2>
      <P>Ivy provides tools that facilitate invoicing, payment collection, payment tracking, and connections to third-party payment processors.</P>
      <P>Unless expressly stated otherwise, Ivy does not act as a bank, escrow provider, payment processor, money transmitter, or merchant of record for transactions between you and your clients.</P>
      <P>Your payment processing relationship is governed by the applicable payment processor's agreements.</P>
      <P>You are responsible for:</P>
      <UL>
        <li>The products and services you offer.</li>
        <li>Your pricing and payment terms.</li>
        <li>Collecting and remitting applicable taxes.</li>
        <li>Issuing accurate invoices and receipts.</li>
        <li>Establishing and communicating cancellation and refund policies.</li>
        <li>Handling customer complaints and disputes.</li>
        <li>Responding to chargebacks and payment reversals.</li>
        <li>Maintaining accurate financial and accounting records.</li>
        <li>Complying with applicable payment processor requirements.</li>
      </UL>
      <P>Ivy does not guarantee that a payment will be authorized, completed, settled, deposited, or available for withdrawal.</P>
      <P>Payment processors may impose fees, reserves, holds, payout delays, verification requirements, account restrictions, or other conditions.</P>
      <P>Information displayed within Ivy may be delayed, incomplete, or inconsistent with information maintained by a payment processor.</P>
      <P>You are responsible for independently reconciling your financial records.</P>
      <P>Ivy is not a party to transactions between you and your clients merely because those transactions are facilitated through the Service.</P>

      <H2>9. Communications, SMS, and Email</H2>
      <P>The Service may allow you to send, schedule, automate, or facilitate communications, including SMS messages, emails, appointment reminders, invoices, marketing messages, and AI-generated communications.</P>
      <P>You are responsible for the content, recipients, timing, frequency, and lawful transmission of communications that you initiate or authorize.</P>
      <P>You agree to comply with applicable communications and marketing laws, including, where applicable:</P>
      <UL>
        <li>The Telephone Consumer Protection Act ("TCPA").</li>
        <li>The CAN-SPAM Act.</li>
        <li>Applicable Federal Communications Commission regulations.</li>
        <li>Applicable state telemarketing and electronic communications laws.</li>
        <li>Carrier requirements and messaging provider policies.</li>
      </UL>
      <P>You must:</P>
      <UL>
        <li>Obtain legally sufficient consent before sending communications where consent is required.</li>
        <li>Obtain any required prior express written consent for marketing communications.</li>
        <li>Maintain appropriate records of consent.</li>
        <li>Accurately identify the sender.</li>
        <li>Provide legally required opt-out mechanisms.</li>
        <li>Honor unsubscribe requests and consent revocations within applicable deadlines.</li>
        <li>Avoid misleading, fraudulent, harassing, or unauthorized communications.</li>
        <li>Comply with applicable restrictions concerning communication frequency and permitted sending hours.</li>
      </UL>
      <P>You must not use Ivy to circumvent opt-out requests, suppression lists, carrier restrictions, or consent requirements.</P>
      <P>Ivy may restrict or suspend messaging functionality where reasonably necessary to prevent abuse, comply with applicable law, or protect the Service and its providers.</P>
      <P>Ivy does not guarantee message delivery, receipt, timing, or recipient engagement.</P>
      <P>Your use of AI-generated or automated communications does not eliminate your responsibility for complying with applicable laws.</P>
      <P>Nothing in this section eliminates Ivy's own obligations under applicable communications laws.</P>

      <H2>10. Business Customers and Their Clients</H2>
      <P>Businesses using Ivy are independently responsible for their relationships with their clients.</P>
      <P>If you operate a business through Ivy, you are responsible for providing your clients with applicable terms, privacy notices, refund policies, cancellation policies, consent disclosures, and other legally required information.</P>
      <P>You are responsible for the quality, legality, safety, and delivery of the products and services you offer.</P>
      <P>Ivy does not endorse, certify, supervise, or guarantee businesses merely because they use the Service.</P>
      <P>If you access a booking page, website, invoice, document, or client portal operated by a business using Ivy, your underlying transaction or service relationship is with that business unless expressly stated otherwise.</P>
      <P>Questions concerning appointments, services, refunds, products, or business-specific policies should ordinarily be directed to the applicable business.</P>
      <P>Ivy remains responsible for its own conduct and obligations under applicable law.</P>

      <H2>11. Acceptable Use</H2>
      <P>You agree not to use the Service to:</P>
      <UL>
        <li>Violate any applicable law, regulation, or legally enforceable obligation.</li>
        <li>Engage in fraud, deception, impersonation, or unlawful discrimination.</li>
        <li>Send spam, phishing messages, malware, or unauthorized communications.</li>
        <li>Harass, threaten, exploit, abuse, or unlawfully monitor another person.</li>
        <li>Collect or process personal information without appropriate authorization.</li>
        <li>Infringe intellectual property, privacy, publicity, or other rights.</li>
        <li>Publish unlawful, fraudulent, or materially misleading content.</li>
        <li>Distribute malicious software or interfere with computer systems.</li>
        <li>Attempt to access accounts, workspaces, or information without authorization.</li>
        <li>Circumvent security measures, usage limits, or access restrictions.</li>
        <li>Conduct unauthorized scraping, automated collection, or bulk extraction.</li>
        <li>Resell, sublicense, or commercially redistribute the Service without permission.</li>
        <li>Use the Service to develop a competing product through unauthorized copying or extraction of proprietary materials.</li>
        <li>Use AI features to facilitate unlawful conduct.</li>
        <li>Provide regulated services without required licenses or authorizations.</li>
        <li>Upload information prohibited under these Terms.</li>
        <li>Use the Service in violation of applicable sanctions or export control laws.</li>
      </UL>
      <P>Ivy may investigate suspected violations and take reasonable measures to protect users, third parties, and the Service.</P>

      <H2>12. Customer Data and Ownership</H2>
      <P>You retain your rights in information, documents, files, client records, invoices, messages, website content, and other materials you lawfully submit to the Service ("Customer Data").</P>
      <P>Nothing in these Terms transfers ownership of Customer Data to Ivy.</P>
      <P>You grant Ivy a limited, worldwide, non-exclusive, royalty-free license to host, store, reproduce, transmit, display, modify as technically necessary, and otherwise process Customer Data for the purposes of:</P>
      <UL>
        <li>Providing and maintaining the Service.</li>
        <li>Performing actions you request or authorize.</li>
        <li>Providing customer support.</li>
        <li>Maintaining security and preventing abuse.</li>
        <li>Complying with applicable legal obligations.</li>
        <li>Performing other processing described in our Privacy Policy and permitted by applicable law.</li>
      </UL>
      <P>Ivy may authorize its service providers to process Customer Data to the extent necessary to perform their contracted services.</P>
      <P>You represent that you have the rights, permissions, and lawful authority necessary to submit Customer Data and authorize its processing.</P>
      <P>You are responsible for the legality, accuracy, and appropriateness of Customer Data you provide.</P>
      <P>Ivy does not claim ownership of your client lists, business records, documents, invoices, or other Customer Data.</P>

      <H2>13. Privacy and Data Processing</H2>
      <P>Our Privacy Policy, available at <LegalLink to="/privacy" style={A}>https://joinivy.ai/privacy</LegalLink>, describes how Ivy collects, uses, retains, and discloses personal information.</P>
      <P>Where Ivy processes personal information on behalf of a business customer and according to that customer's instructions, Ivy acts as a processor or service provider to the extent applicable under relevant privacy laws.</P>
      <P>For processing activities where Ivy independently determines the purposes and means of processing, including certain account administration, subscription billing, security, and platform analytics activities, Ivy may act as an independent controller or business.</P>
      <P>Business customers are responsible for:</P>
      <UL>
        <li>Establishing a lawful basis for collecting and processing personal information.</li>
        <li>Providing legally required privacy notices.</li>
        <li>Obtaining necessary permissions and consents.</li>
        <li>Responding to applicable individual privacy rights requests.</li>
        <li>Providing lawful processing instructions.</li>
        <li>Ensuring their use of the Service complies with applicable privacy laws.</li>
      </UL>
      <P>Where required by applicable law, Ivy and the business customer must enter into an appropriate Data Processing Addendum or other legally required data processing agreement.</P>
      <P>Any applicable Data Processing Addendum governs the parties' processing obligations to the extent of a conflict concerning personal information processing.</P>
      <P>Ivy will process personal information in accordance with applicable law, its Privacy Policy, and applicable contractual data processing obligations.</P>
      <P>Ivy does not sell Customer Data or personal information, or share personal information for cross-context behavioral advertising, as described in its Privacy Policy.</P>

      <H2>14. Product Analytics and De-Identified Information</H2>
      <P>Ivy may collect and use information concerning the operation and use of the Service, including account activity, feature adoption, platform performance, conversion, retention, and business outcome metrics, as described in our Privacy Policy and permitted by applicable law.</P>
      <P>Ivy may use such information to maintain, secure, evaluate, and improve the Service and inform its business operations.</P>
      <P>Ivy may create and use aggregated or appropriately de-identified information for lawful business purposes, including research, product development, analytics, and marketing.</P>
      <P>Where applicable, Ivy will take reasonable measures to prevent de-identified information from being associated with an identifiable individual and will not attempt to re-identify such information except as permitted by law to evaluate de-identification safeguards.</P>
      <P>Ivy will not publish identifiable Customer Data or identifiable client information as part of aggregate marketing statistics without appropriate authorization.</P>
      <P>Ivy does not use Customer Data to train AI models, as described in its Privacy Policy.</P>

      <H2>15. Ivy's Intellectual Property</H2>

      <H3>15.1 Ownership</H3>
      <P>The Service and its underlying intellectual property are owned by Ivy AI LLC or its licensors.</P>
      <P>This includes, without limitation:</P>
      <UL>
        <li>Software and source code.</li>
        <li>Application architecture.</li>
        <li>Designs and user interfaces.</li>
        <li>Graphics and branding.</li>
        <li>Proprietary workflows and methods.</li>
        <li>AI instructions and system prompts.</li>
        <li>Tool configurations.</li>
        <li>Templates and documentation.</li>
        <li>Databases and proprietary compilations.</li>
        <li>The Ivy name, logo, and associated brand assets.</li>
        <li>Updates, improvements, and derivative works of Ivy's proprietary materials.</li>
      </UL>
      <P>These materials are protected by applicable copyright, trademark, trade secret, and other intellectual property laws.</P>
      <P>Except for the limited rights expressly granted in these Terms, Ivy reserves all rights in the Service.</P>

      <H3>15.2 Limited license</H3>
      <P>Subject to your compliance with these Terms, Ivy grants you a limited, non-exclusive, non-transferable, non-sublicensable, revocable right to access and use the Service for its intended purposes.</P>
      <P>This license does not transfer ownership of any part of the Service.</P>

      <H3>15.3 Restrictions</H3>
      <P>Except to the extent expressly permitted by applicable law, you may not:</P>
      <UL>
        <li>Copy, modify, translate, or create unauthorized derivative works of the Service.</li>
        <li>Reverse-engineer, decompile, or disassemble the Service.</li>
        <li>Attempt to extract proprietary source code, AI instructions, system prompts, or confidential implementation details.</li>
        <li>Publish or distribute proprietary materials obtained through unauthorized extraction.</li>
        <li>Scrape, crawl, or automatically collect information from the Service without authorization.</li>
        <li>Collect or compile lists of Ivy's customers or their clients without authorization.</li>
        <li>Use unauthorized access to proprietary materials to develop competing products.</li>
        <li>Frame, mirror, or republish the Service without permission.</li>
        <li>Rent, resell, sublicense, or redistribute access to the Service.</li>
        <li>Remove copyright, trademark, or other proprietary notices.</li>
        <li>Circumvent technical restrictions, security controls, or usage limits.</li>
      </UL>
      <P>These restrictions do not prohibit authorized exports of your own Customer Data, lawful activities protected by applicable law, or authorized public search engine indexing.</P>

      <H3>15.4 Templates and provided materials</H3>
      <P>Ivy may provide website templates, document templates, sample communications, graphics, and other materials.</P>
      <P>You may use these materials for your own business through the Service and in authorized documents or pages created through the Service.</P>
      <P>You may not independently resell or redistribute Ivy's proprietary templates or materials without written permission.</P>
      <P>Your original content remains yours.</P>

      <H3>15.5 Trademarks</H3>
      <P>You may not use Ivy's name, logo, or confusingly similar branding in a manner that falsely suggests sponsorship, endorsement, affiliation, or authorization.</P>
      <P>You may truthfully identify your business as a user of Ivy.</P>
      <P>Nothing in these Terms restricts lawful nominative fair use or other rights provided by applicable law.</P>

      <H3>15.6 Feedback</H3>
      <P>If you voluntarily provide suggestions, ideas, or feedback concerning the Service, you grant Ivy a perpetual, worldwide, irrevocable, royalty-free license to use, modify, incorporate, and otherwise exploit that feedback without compensation.</P>
      <P>This provision does not transfer ownership of your Customer Data or authorize the disclosure of confidential personal information.</P>

      <H3>15.7 Protection of proprietary technology</H3>
      <P>Ivy may monitor usage patterns for indications of unauthorized access, automated extraction, copying, or abuse.</P>
      <P>Where reasonably necessary, Ivy may impose rate limits, restrict functionality, or suspend access while investigating suspected violations.</P>

      <H2>16. Hosted Content and Copyright Complaints</H2>
      <P>You are responsible for content you publish through Ivy, including websites, booking pages, images, documents, business descriptions, and communications.</P>
      <P>You represent that you possess the necessary rights and permissions to publish that content.</P>
      <P>Ivy may remove or restrict access to content reasonably believed to violate applicable law, third-party rights, or these Terms.</P>
      <P>Ivy may suspend or terminate accounts of repeat intellectual property infringers in appropriate circumstances.</P>
      <P>Copyright owners may submit infringement complaints to <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a>.</P>
      <P>A copyright complaint should include, as applicable:</P>
      <UL>
        <li>Identification of the copyrighted work.</li>
        <li>Identification and location of the allegedly infringing material.</li>
        <li>The complainant's contact information.</li>
        <li>A statement of good-faith belief that the disputed use is unauthorized.</li>
        <li>A statement that the information provided is accurate and that the complainant is authorized to act on behalf of the rights holder.</li>
        <li>A physical or electronic signature.</li>
      </UL>
      <P>Ivy will handle copyright complaints and applicable counter-notices in accordance with applicable law.</P>

      <H2>17. Confidentiality and Security</H2>
      <P>Ivy will use reasonable administrative, technical, and organizational safeguards appropriate to the nature of the information it processes and applicable legal requirements.</P>
      <P>No software platform, storage system, or method of electronic transmission can be guaranteed to be completely secure.</P>
      <P>You are responsible for maintaining reasonable security practices, protecting your credentials, managing authorized access, and securing devices used to access the Service.</P>
      <P>You must promptly notify Ivy if you become aware of unauthorized access, compromised credentials, or a security incident affecting your account.</P>
      <P>Ivy may investigate security incidents and take reasonable protective measures, including temporarily restricting access.</P>
      <P>Ivy will provide legally required security incident notifications in accordance with applicable law and applicable contractual obligations.</P>
      <P>Neither party may use or disclose the other party's nonpublic confidential business information except as authorized, reasonably necessary to perform applicable obligations, or required by law.</P>

      <H2>18. Service Availability, Changes, and Backups</H2>
      <P>Ivy seeks to maintain reliable access to the Service but does not guarantee uninterrupted availability.</P>
      <P>The Service may experience downtime, maintenance, technical errors, delays, interruptions, or temporary unavailability.</P>
      <P>Ivy may modify, update, replace, restrict, or discontinue features as the Service evolves, subject to applicable law and existing contractual obligations.</P>
      <P>Where reasonably practicable, Ivy will provide notice of material changes that significantly affect paid functionality.</P>
      <P>You are responsible for maintaining independent backups of business information that is important to your operations.</P>
      <P>The Account Settings page provides workspace export functionality.</P>
      <P>The Service should not be used as the sole repository for information that you are legally required to retain or that would cause material harm if lost.</P>

      <H2>19. Subscription Fees, Billing, and Automatic Renewal</H2>

      <H3>19.1 Paid subscriptions</H3>
      <P>Ivy is offered through paid subscriptions, which may include weekly or annual billing plans.</P>
      <P>Applicable pricing, billing frequency, trial terms, and subscription conditions will be disclosed before purchase.</P>
      <P>By purchasing a subscription and affirmatively consenting to recurring charges, you authorize Ivy or the applicable billing provider to charge your selected payment method according to the disclosed subscription terms.</P>

      <H3>19.2 Automatic renewal</H3>
      <P>Unless canceled, your subscription automatically renews for successive billing periods at the applicable subscription price.</P>
      <P>Your payment method will be charged at the beginning of each renewal period, subject to applicable law and the subscription terms presented at purchase.</P>
      <P>Ivy will provide legally required acknowledgments, renewal reminders, and other notices.</P>

      <H3>19.3 Free trials</H3>
      <P>If you enroll in a free trial that automatically converts into a paid subscription, the trial duration, subsequent price, billing frequency, and applicable cancellation deadline will be disclosed before enrollment.</P>
      <P>Automatic conversion will occur only where you have provided the consent required by applicable law.</P>
      <P>You may cancel before the disclosed trial expiration or applicable cancellation deadline to avoid being charged.</P>
      <P>Ivy will provide legally required trial expiration and conversion notices.</P>

      <H3>19.4 Cancellation</H3>
      <P>You may cancel your subscription through the applicable subscription management mechanism.</P>
      <P>For subscriptions purchased directly through Ivy, cancellation is available through the applicable account or subscription settings.</P>
      <P>Subscriptions purchased through Apple or another third-party billing provider may need to be managed through that provider's subscription settings.</P>
      <P>Ivy will provide cancellation mechanisms and instructions consistent with applicable law.</P>
      <P>Unless otherwise required by law or stated at purchase, cancellation takes effect at the end of the current paid billing period.</P>
      <P>Canceling a subscription prevents future renewal charges but does not ordinarily result in a prorated refund for the current billing period.</P>

      <H3>19.5 Refunds</H3>
      <P>Subscription fees are non-refundable except where required by applicable law, expressly provided under the applicable purchase terms, or otherwise agreed by Ivy.</P>
      <P>Nothing in these Terms limits any mandatory refund, cancellation, or consumer protection rights.</P>
      <P>Refund requests for subscriptions purchased through a third-party app store may be subject to that provider's applicable refund procedures.</P>

      <H3>19.6 Price changes</H3>
      <P>Ivy may change subscription pricing by providing at least 30 days' advance notice by email, or additional notice where required by applicable law.</P>
      <P>Price changes will apply no earlier than the applicable renewal date following the required notice period.</P>
      <P>Where legally required, Ivy will obtain additional consent before charging a changed price.</P>
      <P>You may cancel your subscription before the price change takes effect.</P>

      <H3>19.7 Failed payments</H3>
      <P>If a payment fails, Ivy may retry the payment where authorized, notify you, restrict paid functionality, or suspend your subscription, subject to applicable law.</P>
      <P>You are responsible for maintaining accurate billing information and a valid payment method.</P>

      <H3>19.8 Third-party fees and taxes</H3>
      <P>Payment processing fees charged by Stripe, Square, PayPal, or other payment providers are separate from Ivy's subscription fees.</P>
      <P>Applicable taxes may be added to subscription charges where required.</P>

      <H2>20. Data Retention, Account Deletion, and Subscription Expiration</H2>
      <P>Ivy's data retention practices are described in its Privacy Policy.</P>
      <P>When your paid subscription ends, your booking page, website, and client portal may be archived.</P>
      <P>Your workspace data will ordinarily remain available for export for seven days following the end of your paid subscription.</P>
      <P>Unless you resubscribe before the applicable deletion deadline, workspace data will be deleted following that retention period, subject to applicable legal obligations, backup retention, and other exceptions described in our Privacy Policy.</P>
      <P>If you complete a free trial without subscribing, your workspace data will ordinarily be retained for four weeks following the end of the trial before deletion.</P>
      <P>Ivy will provide deletion notices as described in its Privacy Policy.</P>
      <P>You may request account deletion through Account Settings or by contacting Ivy.</P>
      <P>Account deletion requests will ordinarily be completed within 30 days, subject to applicable law and the retention exceptions described in our Privacy Policy.</P>
      <P>Certain information may be retained where reasonably necessary or legally permitted for:</P>
      <UL>
        <li>Tax, accounting, and financial recordkeeping.</li>
        <li>Fraud and abuse prevention.</li>
        <li>Security investigations.</li>
        <li>Legal obligations.</li>
        <li>Dispute resolution.</li>
        <li>Enforcement of agreements.</li>
        <li>Backup retention.</li>
        <li>Prevention of repeated free-trial abuse.</li>
      </UL>
      <P>Retained information remains subject to applicable privacy and security obligations.</P>
      <P>You are responsible for exporting information you wish to retain before the applicable deletion deadline.</P>
      <P>Ivy does not guarantee that deleted information can be restored.</P>

      <H2>21. Suspension and Termination</H2>
      <P>You may stop using the Service at any time.</P>
      <P>You may cancel your subscription or request account deletion using the applicable mechanisms.</P>
      <P>Ivy may suspend, restrict, or terminate access where reasonably necessary due to:</P>
      <UL>
        <li>Material violations of these Terms.</li>
        <li>Fraudulent, unlawful, or abusive activity.</li>
        <li>Security threats.</li>
        <li>Unauthorized access or intellectual property infringement.</li>
        <li>Nonpayment.</li>
        <li>Violations of third-party provider requirements affecting the Service.</li>
        <li>Legal obligations or governmental orders.</li>
        <li>Conduct that materially threatens Ivy, its users, or third parties.</li>
      </UL>
      <P>Where reasonably practicable and appropriate, Ivy will provide notice and an opportunity to address a remediable violation.</P>
      <P>Ivy may act immediately without advance notice where reasonably necessary to address fraud, security threats, unlawful activity, urgent harm, or legal requirements.</P>
      <P>Termination does not eliminate obligations or liabilities arising before termination.</P>
      <P>Any refund rights arising from termination will be determined under applicable law and the applicable subscription terms.</P>

      <H2>22. Disclaimer of Warranties</H2>
      <P><strong>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE.</strong></P>
      <P><strong>IVY DISCLAIMS IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, TITLE, ACCURACY, RELIABILITY, AND WARRANTIES ARISING FROM COURSE OF DEALING, COURSE OF PERFORMANCE, OR USAGE OF TRADE, TO THE EXTENT SUCH WARRANTIES MAY LAWFULLY BE DISCLAIMED.</strong></P>
      <P><strong>IVY DOES NOT WARRANT THAT:</strong></P>
      <UL>
        <li>THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR COMPLETELY SECURE.</li>
        <li>DEFECTS WILL BE CORRECTED WITHIN ANY PARTICULAR TIME.</li>
        <li>AI-GENERATED OUTPUT WILL BE ACCURATE OR SUITABLE.</li>
        <li>AUTOMATED ACTIONS WILL ALWAYS PRODUCE THEIR INTENDED RESULTS.</li>
        <li>THIRD-PARTY INTEGRATIONS WILL REMAIN AVAILABLE.</li>
        <li>INFORMATION DISPLAYED THROUGH THE SERVICE WILL BE COMPLETE OR CURRENT.</li>
        <li>THE SERVICE WILL SATISFY YOUR PARTICULAR BUSINESS OR REGULATORY REQUIREMENTS.</li>
      </UL>
      <P><strong>NO INFORMATION OR COMMUNICATION PROVIDED BY IVY CREATES A WARRANTY NOT EXPRESSLY STATED IN THESE TERMS.</strong></P>
      <P>Nothing in these Terms excludes warranties, guarantees, or rights that cannot lawfully be excluded.</P>

      <H2>23. Limitation of Liability</H2>
      <P>For purposes of this section and Sections 24 and 25, the "Ivy Parties" include Ivy AI LLC and its members, owners, founders, managers, officers, directors, employees, agents, representatives, affiliates, contractors, licensors, successors, and assigns.</P>

      <H3>23.1 Exclusion of certain damages</H3>
      <P><strong>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE IVY PARTIES WILL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES ARISING OUT OF OR RELATING TO THE SERVICE OR THESE TERMS.</strong></P>
      <P>This includes, to the extent lawfully excludable, damages arising from:</P>
      <UL>
        <li>Lost profits or revenue.</li>
        <li>Lost business opportunities.</li>
        <li>Loss of clients or goodwill.</li>
        <li>Business interruption.</li>
        <li>Loss of anticipated savings.</li>
        <li>Loss of use or data.</li>
        <li>Inaccurate AI-generated output.</li>
        <li>Unintended automated actions.</li>
        <li>Third-party service interruptions.</li>
        <li>Communications or transactions between businesses and their clients.</li>
      </UL>
      <P>These limitations apply regardless of the legal theory asserted and whether the possibility of such damages was known or reasonably foreseeable, subject to applicable law.</P>

      <H3>23.2 Aggregate liability cap</H3>
      <P><strong>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE TOTAL AGGREGATE LIABILITY OF THE IVY PARTIES ARISING OUT OF OR RELATING TO THE SERVICE OR THESE TERMS WILL NOT EXCEED THE GREATER OF:</strong></P>
      <P><strong>(a) THE TOTAL SUBSCRIPTION FEES YOU PAID TO IVY DURING THE TWELVE MONTHS IMMEDIATELY PRECEDING THE EVENT GIVING RISE TO THE CLAIM; OR</strong></P>
      <P><strong>(b) ONE HUNDRED UNITED STATES DOLLARS (USD $100).</strong></P>
      <P>This is an aggregate limitation and not a separate limitation for each claim, event, individual, or legal theory, to the extent permitted by applicable law.</P>

      <H3>23.3 Mandatory exceptions</H3>
      <P>Nothing in these Terms excludes or limits liability for fraud, fraudulent misrepresentation, willful misconduct, gross negligence where such limitation is prohibited, injury to persons or property where liability cannot lawfully be limited, violations of law where such exclusion is prohibited, or any other liability that cannot be excluded or limited under applicable law.</P>
      <P>These limitations are intended to apply consistently with California Civil Code Section 1668 and other applicable mandatory legal requirements.</P>
      <P>Nothing in these Terms waives nonwaivable statutory privacy, consumer protection, or other legal rights.</P>

      <H2>24. Assumption of Risk and Limited Release</H2>
      <P>You acknowledge that operating a business involves inherent risks and that the Service is a tool intended to assist, rather than replace, your independent judgment.</P>
      <P>To the maximum extent permitted by law, you assume responsibility for risks arising from:</P>
      <UL>
        <li>Your independent business decisions.</li>
        <li>Your products and services.</li>
        <li>Your relationships with clients.</li>
        <li>Your tax, licensing, and regulatory obligations.</li>
        <li>Communications you authorize.</li>
        <li>Your reliance on unverified AI-generated information.</li>
        <li>Your independent relationships with third-party providers.</li>
      </UL>
      <P>To the extent permitted by applicable law, you release the Ivy Parties from claims arising solely from disputes between you and your clients or other independent third parties, where those disputes are not attributable to actionable conduct by an Ivy Party.</P>
      <P>This release does not extend to claims arising from conduct for which liability cannot lawfully be waived, or to claims arising from Ivy's own breach of obligations where such a release would be unenforceable.</P>

      <H2>25. Indemnification</H2>
      <P>To the maximum extent permitted by applicable law, you agree to defend, indemnify, and hold harmless the Ivy Parties from third-party claims, demands, damages, judgments, liabilities, and reasonable costs and expenses, including reasonable attorneys' fees, to the extent arising from:</P>
      <UL>
        <li>Your material violation of these Terms.</li>
        <li>Your unlawful use of the Service.</li>
        <li>Customer Data or content you submit or publish that violates another person's rights.</li>
        <li>Your products, services, or business activities.</li>
        <li>Your unauthorized or unlawful communications.</li>
        <li>Your failure to obtain legally required permissions or consents.</li>
        <li>Your violation of applicable privacy, marketing, payment, or consumer protection laws.</li>
        <li>Your infringement of intellectual property or other third-party rights.</li>
        <li>Actions taken by individuals you authorize to access your workspace.</li>
      </UL>
      <P>This obligation does not apply to the extent a claim results from an Ivy Party's own negligence, unlawful conduct, breach of applicable obligations, or other conduct for which indemnification is prohibited by law.</P>
      <P>Ivy will provide reasonably prompt notice of claims subject to indemnification.</P>
      <P>Ivy may participate in the defense of such claims with counsel of its choosing.</P>
      <P>You may not settle a claim in a manner that imposes liability, obligations, or admissions of wrongdoing on an Ivy Party without that party's prior written consent.</P>
      <P>This section does not impose indemnification obligations on consumers where prohibited by applicable law.</P>

      <H2>26. Force Majeure</H2>
      <P>Neither party will be responsible for delays or failures to perform obligations to the extent caused by circumstances beyond its reasonable control.</P>
      <P>Such circumstances may include natural disasters, severe weather, widespread internet outages, power failures, governmental actions, war, civil unrest, labor disruptions, public health emergencies, and major third-party infrastructure failures.</P>
      <P>The affected party will take reasonable steps to mitigate the effects of the disruption.</P>
      <P>This section does not excuse obligations that cannot lawfully be excused or payment obligations that became due before the applicable disruption.</P>

      <H2>27. Governing Law</H2>
      <P>These Terms are governed by the laws of the State of California, without regard to its conflict-of-law principles, except that the Federal Arbitration Act governs the interpretation and enforcement of the arbitration provisions where applicable.</P>
      <P>If you reside in another jurisdiction, nothing in these Terms deprives you of mandatory legal protections applicable to you that cannot lawfully be waived through a choice-of-law provision.</P>

      <H2>28. Dispute Resolution and Arbitration</H2>
      <P><strong>PLEASE READ THIS SECTION CAREFULLY. IT AFFECTS YOUR RIGHT TO BRING CLAIMS IN COURT AND TO PARTICIPATE IN CLASS PROCEEDINGS.</strong></P>

      <H3>28.1 Informal dispute resolution</H3>
      <P>Before initiating arbitration or litigation, except where an exception below applies, you and Ivy agree to make a good-faith effort to resolve the dispute informally.</P>
      <P>A notice of dispute should include:</P>
      <UL>
        <li>The claimant's name and contact information.</li>
        <li>A description of the dispute.</li>
        <li>The relevant facts.</li>
        <li>The requested resolution.</li>
      </UL>
      <P>Notices to Ivy may be sent to <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a> with the subject line "Notice of Dispute."</P>
      <P>Ivy may send notices to the email address associated with your account.</P>
      <P>The parties will have 30 days following receipt of a reasonably complete notice to attempt informal resolution.</P>
      <P>Applicable limitation periods will be tolled during this required informal resolution period to the extent permitted by law.</P>
      <P>This requirement does not prevent either party from seeking urgent relief, filing a timely claim necessary to preserve legal rights, or communicating with governmental authorities.</P>

      <H3>28.2 Agreement to arbitrate</H3>
      <P>Except as expressly provided below, disputes arising out of or relating to these Terms, the Service, or the relationship between you and Ivy will be resolved through individual binding arbitration rather than a court trial.</P>
      <P>Arbitration will be administered by the American Arbitration Association ("AAA") under its applicable rules, including its Consumer Arbitration Rules where applicable.</P>
      <P>The AAA's rules are available at <a href="https://www.adr.org" target="_blank" rel="noopener noreferrer" style={A}>https://www.adr.org</a>.</P>
      <P>The Federal Arbitration Act governs this arbitration agreement where applicable.</P>
      <P>The arbitrator may award any individual remedy available under applicable law.</P>
      <P>Nothing in this agreement limits legally available remedies that cannot lawfully be restricted.</P>

      <H3>28.3 Arbitration costs and location</H3>
      <P>Arbitration fees and costs will be allocated in accordance with the applicable AAA rules and mandatory law.</P>
      <P>Ivy will pay fees that it is required to pay under those rules or applicable law.</P>
      <P>Where consumer arbitration rules apply, arbitration may take place remotely or in a reasonably convenient location consistent with those rules.</P>
      <P>Nothing in these Terms requires a consumer to travel to California where doing so would violate applicable law or arbitration rules.</P>

      <H3>28.4 Exceptions</H3>
      <P>Either party may bring an eligible individual claim in small claims court.</P>
      <P>Either party may seek temporary or emergency injunctive relief from a court of competent jurisdiction where necessary to prevent imminent harm or preserve legal rights pending arbitration.</P>
      <P>Nothing in these Terms prevents you from reporting concerns to governmental agencies, regulators, or law enforcement.</P>
      <P>Claims that cannot lawfully be subjected to predispute arbitration are excluded from this arbitration requirement.</P>

      <H3>28.5 Individual proceedings and class-action waiver</H3>
      <P><strong>TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, YOU AND IVY AGREE THAT DISPUTES SUBJECT TO ARBITRATION WILL BE RESOLVED ON AN INDIVIDUAL BASIS AND NOT AS PART OF A CLASS, COLLECTIVE, OR REPRESENTATIVE PROCEEDING.</strong></P>
      <P>This provision does not waive any right to seek public injunctive relief where such a waiver is prohibited by law.</P>
      <P>Nothing in this provision prohibits participation in governmental investigations or proceedings or restricts rights that cannot lawfully be waived.</P>
      <P>If a court determines that a particular claim or requested remedy cannot lawfully be subject to this individual arbitration requirement, that claim or remedy may proceed in a court of competent jurisdiction, while remaining arbitrable claims will proceed in arbitration to the extent permitted by law.</P>

      <H3>28.6 Right to opt out</H3>
      <P>You may opt out of this arbitration agreement by sending an email to <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a> within 30 days after you first affirmatively accept Terms containing this arbitration agreement.</P>
      <P>Your email must include:</P>
      <UL>
        <li>Your name.</li>
        <li>The email address associated with your account.</li>
        <li>A clear statement that you wish to opt out of the arbitration agreement.</li>
      </UL>
      <P>The subject line should be "Arbitration Opt-Out."</P>
      <P>Opting out will not affect your ability to use the Service or the enforceability of other provisions of these Terms.</P>
      <P>If you previously validly opted out of an Ivy arbitration agreement, that opt-out will remain effective unless you subsequently expressly agree otherwise.</P>

      <H3>28.7 Court jurisdiction</H3>
      <P>For disputes not subject to arbitration, the parties agree to the jurisdiction of the state courts located in San Francisco County, California, or the applicable federal court serving that county, except where applicable law provides a nonwaivable right to bring a claim elsewhere.</P>

      <H3>28.8 Changes to arbitration provisions</H3>
      <P>Material changes to this arbitration agreement will not apply retroactively to disputes that arose before the changes became effective without the parties' agreement.</P>
      <P>Ivy will provide advance notice of material changes and any additional opt-out rights required by applicable law.</P>

      <H2>29. Electronic Communications and Agreements</H2>
      <P>You agree that Ivy may provide service-related communications, contractual notices, subscription acknowledgments, and other legally permitted notices electronically.</P>
      <P>These may be provided through email, in-app notifications, or other appropriate electronic mechanisms.</P>
      <P>You are responsible for maintaining a current email address associated with your account.</P>
      <P>Where applicable law requires additional consent or specific disclosures for electronic records or signatures, Ivy will comply with those requirements.</P>
      <P>The use of electronic communications does not waive your right to receive information in another format where required by law.</P>

      <H2>30. Changes to These Terms</H2>
      <P>Ivy may update these Terms as the Service, business practices, and legal requirements evolve.</P>
      <P>For material changes, Ivy will provide at least 14 days' advance notice through email, in-app notification, or another appropriate mechanism, except where a shorter period is legally required or reasonably necessary to address an urgent legal or security issue.</P>
      <P>Where required by applicable law or necessary to establish agreement to material changes, Ivy will request your affirmative acceptance before continued use of the affected Service.</P>
      <P>Changes will apply prospectively unless otherwise lawfully agreed.</P>
      <P>If you do not agree to updated Terms, you may discontinue use, cancel your subscription, and export your data in accordance with the applicable provisions.</P>
      <P>Nothing in this section permits Ivy to unilaterally eliminate accrued legal rights or retroactively impose obligations where prohibited by law.</P>

      <H2>31. Assignment and Business Transfers</H2>
      <P>You may not assign or transfer your account or rights under these Terms without Ivy's prior written consent, except where applicable law provides otherwise.</P>
      <P>Ivy may assign or transfer these Terms in connection with a merger, acquisition, reorganization, financing, sale of assets, or other lawful business transaction.</P>
      <P>Any transfer of personal information will be subject to applicable law, the Privacy Policy, and applicable contractual data protection obligations.</P>
      <P>An assignment does not eliminate rights or protections that cannot lawfully be modified or waived.</P>

      <H2>32. No Third-Party Beneficiaries</H2>
      <P>Except as expressly stated in these Terms, these Terms do not create enforceable rights for persons or entities other than you and Ivy.</P>
      <P>The Ivy Parties identified in Section 23 are intended third-party beneficiaries of the applicable liability limitations, releases, indemnification provisions, and related protections, to the extent permitted by law.</P>

      <H2>33. Severability</H2>
      <P>If any provision of these Terms is determined to be invalid, unlawful, or unenforceable, the remaining provisions will remain effective to the extent permitted by law.</P>
      <P>An unenforceable provision may be interpreted or limited to the extent necessary to make it enforceable, where legally permitted.</P>
      <P>The specific severability provisions governing arbitration and class proceedings will control where applicable.</P>

      <H2>34. No Waiver</H2>
      <P>Ivy's failure or delay in exercising a right or enforcing a provision of these Terms does not constitute a waiver of that right or provision.</P>
      <P>A waiver concerning one circumstance does not constitute a waiver concerning any other circumstance.</P>

      <H2>35. Survival</H2>
      <P>Provisions that by their nature are intended to continue after expiration or termination will survive to the extent applicable and permitted by law.</P>
      <P>These include provisions concerning:</P>
      <UL>
        <li>Accrued payment obligations.</li>
        <li>Intellectual property ownership.</li>
        <li>Confidentiality.</li>
        <li>Applicable data retention obligations.</li>
        <li>Disclaimers.</li>
        <li>Limitations of liability.</li>
        <li>Indemnification.</li>
        <li>Dispute resolution.</li>
        <li>Governing law.</li>
      </UL>

      <H2>36. Entire Agreement</H2>
      <P>These Terms, together with the Privacy Policy, applicable subscription terms presented at purchase, and any other agreements expressly incorporated or separately accepted by the parties, constitute the agreement governing your use of the Service.</P>
      <P>An applicable Data Processing Addendum will control in the event of a conflict concerning the processing of personal information.</P>
      <P>Any separately executed written agreement will control to the extent it expressly supersedes a provision of these Terms.</P>
      <P>Nothing in this section excludes liability for fraudulent representations or other rights that cannot lawfully be waived.</P>

      <H2>37. Contact Information</H2>
      <P>The Service is operated by:</P>
      <P>Ivy AI LLC</P>
      <P>California, United States</P>
      <P>General support and contractual inquiries: <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a></P>
      <P>Privacy and data protection inquiries: <a href="mailto:support@joinivy.ai" style={A}>support@joinivy.ai</a></P>
      <P>Website: <a href="https://joinivy.ai" style={A}>https://joinivy.ai</a></P>
      <P>Privacy Policy: <LegalLink to="/privacy" style={A}>https://joinivy.ai/privacy</LegalLink></P>
    </LegalPage>
  );
}
