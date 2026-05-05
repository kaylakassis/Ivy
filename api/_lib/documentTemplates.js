// Built-in starter templates surfaced in the "New document" gallery.
// These are STATIC data (not user-editable), live in JS, and clone
// into a fresh draft when the user picks one. Per-workspace
// user-defined templates live in the documents table with
// is_template=TRUE — different feature, different storage.
//
// Each template includes a body in our minimal HTML subset (h1/h2/h3,
// p, br, strong, em, ul/ol/li — anything else is stripped by the sign
// page sanitizer) and a starter field list. Fields are flat (no
// PDF coordinates) — owners can swap to a PDF after creation if they
// want visual placement.
//
// IMPORTANT: these are STARTING POINTS, not legal advice. The
// gallery UI must show the disclaimer surfaced to the user. We're
// neither lawyers nor liable for what people use these for; they're
// here so a coach with no Word template at hand isn't writing a
// liability waiver from a blank textarea at 11 PM.

const SIG_DATE = [
  { id: 'sig',  type: 'signature', label: 'Signature', required: true,  value: '', signerIndex: 0 },
  { id: 'date', type: 'date',      label: 'Date',      required: true,  value: '', signerIndex: 0 },
];

export const DOCUMENT_TEMPLATES = [
  // ─── Fitness ────────────────────────────────────────────────────
  {
    id: 'fitness-liability-waiver',
    category: 'Fitness',
    name: 'Personal Training Liability Waiver',
    description: 'Standard release of liability for one-on-one or small-group training.',
    suggestedSigners: 1,
    body: `
<h2>Release and Waiver of Liability</h2>
<p>I understand that participating in physical exercise involves inherent risks, including but not limited to muscle strain, sprains, falls, cardiovascular events, and other forms of injury. I acknowledge that I am voluntarily participating in personal training services with full awareness of these risks.</p>
<h3>Health representations</h3>
<p>I represent that I have no medical condition that would prevent me from participating in physical activity, or that I have consulted with a licensed physician and have been cleared to participate. I agree to inform my trainer of any change in my health status, medications, or physical condition before each session.</p>
<h3>Assumption of risk</h3>
<p>I knowingly and voluntarily accept and assume all risks associated with my participation. I waive any claims I might otherwise have against my trainer or this business arising from my participation, except those caused by gross negligence or willful misconduct.</p>
<h3>Photo and recording consent</h3>
<p>From time to time, my trainer may capture photos or video for technique review or marketing. I will be informed before any media is captured and may decline at any time.</p>
<p><strong>By signing below, I confirm that I have read and understood this waiver and agree to its terms.</strong></p>
`.trim(),
    fields: SIG_DATE,
  },
  {
    id: 'fitness-intake',
    category: 'Fitness',
    name: 'Fitness Intake Form',
    description: 'Health history and goal questionnaire to capture before the first session.',
    suggestedSigners: 1,
    body: `
<h2>New Client Intake</h2>
<p>Please complete this form before our first session. The information helps me design a program that's safe and effective for you.</p>
<h3>Goals</h3>
<p>What are your top three fitness goals over the next 90 days?</p>
<h3>Health history</h3>
<p>Please list any current or recent injuries, surgeries, or medical conditions that may affect your training. If you take medications that affect heart rate, blood pressure, or balance, please list them.</p>
<h3>Activity level</h3>
<p>Approximately how many hours per week do you currently exercise? What types of activity?</p>
<h3>Acknowledgement</h3>
<p>I confirm the information above is accurate to the best of my knowledge and I will update my trainer if anything changes.</p>
`.trim(),
    fields: [
      { id: 'goals',    type: 'text',      label: 'Top 3 goals (90 days)',       required: true,  value: '', signerIndex: 0 },
      { id: 'history',  type: 'text',      label: 'Injuries / medical history',  required: true,  value: '', signerIndex: 0 },
      { id: 'meds',     type: 'text',      label: 'Current medications',         required: false, value: '', signerIndex: 0 },
      { id: 'activity', type: 'text',      label: 'Current weekly activity',     required: true,  value: '', signerIndex: 0 },
      { id: 'sig',      type: 'signature', label: 'Signature',                   required: true,  value: '', signerIndex: 0 },
      { id: 'date',     type: 'date',      label: 'Date',                        required: true,  value: '', signerIndex: 0 },
    ],
  },

  // ─── Wellness / Massage ─────────────────────────────────────────
  {
    id: 'wellness-massage-intake',
    category: 'Wellness',
    name: 'Massage Therapy Intake & Consent',
    description: 'Health history, areas of concern, and consent for hands-on bodywork.',
    suggestedSigners: 1,
    body: `
<h2>Massage Therapy Intake & Consent</h2>
<p>Massage therapy is the application of various techniques to the muscular and soft tissues of the body. It is not a substitute for medical care.</p>
<h3>Areas of concern</h3>
<p>Please describe any current pain, tension, or areas you'd like the session to focus on. Note any areas to avoid.</p>
<h3>Health history</h3>
<p>Please list any of the following that apply: recent injuries or surgeries, pregnancy, blood thinners or circulatory conditions, skin conditions, allergies, history of cancer, or any other condition I should know about before working with you.</p>
<h3>Informed consent</h3>
<p>I understand that this session is therapeutic in nature. I may ask my therapist to adjust pressure, stop work in any area, or end the session at any time. I will inform my therapist immediately if I experience any discomfort.</p>
<h3>Confidentiality</h3>
<p>My therapist will keep all health information shared in this form confidential and will only disclose it with my written consent or as required by law.</p>
`.trim(),
    fields: [
      { id: 'concerns', type: 'text',      label: 'Areas of concern / focus',          required: true,  value: '', signerIndex: 0 },
      { id: 'history',  type: 'text',      label: 'Relevant health history',           required: true,  value: '', signerIndex: 0 },
      { id: 'avoid',    type: 'text',      label: 'Areas to avoid',                    required: false, value: '', signerIndex: 0 },
      { id: 'sig',      type: 'signature', label: 'Signature',                         required: true,  value: '', signerIndex: 0 },
      { id: 'date',     type: 'date',      label: 'Date',                              required: true,  value: '', signerIndex: 0 },
    ],
  },
  {
    id: 'wellness-liability',
    category: 'Wellness',
    name: 'Wellness Service Liability Waiver',
    description: 'Generic release for energy work, breathwork, holistic services.',
    suggestedSigners: 1,
    body: `
<h2>Wellness Services Release of Liability</h2>
<p>I am voluntarily engaging the wellness services of this practitioner. I understand that these services are not a substitute for medical, psychological, or psychiatric care, and that the practitioner is not providing medical diagnosis, treatment, or advice.</p>
<p>I represent that I have considered any relevant health conditions before scheduling and have, where appropriate, consulted with my physician. I will inform my practitioner immediately of any discomfort during a session.</p>
<p>I release the practitioner and this business from any claims arising out of my participation, except those caused by gross negligence or willful misconduct.</p>
<p><strong>By signing, I confirm I have read and understood this waiver.</strong></p>
`.trim(),
    fields: SIG_DATE,
  },

  // ─── Beauty ─────────────────────────────────────────────────────
  {
    id: 'beauty-consent',
    category: 'Beauty',
    name: 'Beauty Service Consent',
    description: 'Pre-service consent covering color, chemical processing, and skin tests.',
    suggestedSigners: 1,
    body: `
<h2>Beauty Service Consent</h2>
<p>I am requesting a service that may involve color, chemical, heat, or skin-contact products. I understand that all skin and hair reacts differently and that no result is guaranteed.</p>
<h3>Allergies and sensitivities</h3>
<p>Please disclose any allergies, sensitivities, or skin conditions, and any product or service you have previously had a reaction to.</p>
<h3>Patch testing</h3>
<p>For services that involve dyes or chemical products, I have been offered a patch test and either accepted or declined it understanding the risks.</p>
<h3>Aftercare</h3>
<p>I understand that following the aftercare instructions provided by my service provider is essential to results. I take responsibility for following them.</p>
`.trim(),
    fields: [
      { id: 'allergies', type: 'text',      label: 'Allergies / sensitivities',  required: true,  value: '', signerIndex: 0 },
      { id: 'sig',       type: 'signature', label: 'Signature',                  required: true,  value: '', signerIndex: 0 },
      { id: 'date',      type: 'date',      label: 'Date',                       required: true,  value: '', signerIndex: 0 },
    ],
  },
  {
    id: 'photo-release',
    category: 'Beauty',
    name: 'Photo & Marketing Release',
    description: 'Permission to use before/after photos in marketing.',
    suggestedSigners: 1,
    body: `
<h2>Photo & Marketing Release</h2>
<p>I grant permission to use photographs taken before, during, and after my service for the purposes of marketing, including but not limited to social media, the business website, printed materials, and online advertising.</p>
<p>I understand that I am not entitled to compensation for the use of these images and that I may revoke this consent in writing at any time, after which no new uses will occur (existing materials may continue to circulate).</p>
<p>If I prefer that my face not be shown, I can indicate that below. I understand that body or detail shots may still be used.</p>
`.trim(),
    fields: [
      { id: 'face-ok',  type: 'text',      label: 'Face shown? (yes / body only / no)', required: true, value: '', signerIndex: 0 },
      { id: 'sig',      type: 'signature', label: 'Signature', required: true, value: '', signerIndex: 0 },
      { id: 'date',     type: 'date',      label: 'Date',      required: true, value: '', signerIndex: 0 },
    ],
  },

  // ─── Coaching / Professional ────────────────────────────────────
  {
    id: 'coaching-agreement',
    category: 'Coaching',
    name: 'One-on-One Coaching Agreement',
    description: 'Term, scope, fees, confidentiality, cancellation. Two-signer.',
    suggestedSigners: 2,
    body: `
<h2>Coaching Services Agreement</h2>
<p>This agreement is between the coach and the client named below.</p>
<h3>1. Services</h3>
<p>The coach will provide one-on-one coaching sessions as scheduled. Coaching is collaborative and forward-looking; it is not therapy, counseling, medical advice, financial advice, or legal advice. The client is responsible for their own decisions and outcomes.</p>
<h3>2. Fees and payment</h3>
<p>Fees are due at the time of booking unless otherwise agreed. Sessions not paid for will be rescheduled.</p>
<h3>3. Cancellation and rescheduling</h3>
<p>Sessions cancelled with less than 24 hours' notice may be charged in full at the coach's discretion.</p>
<h3>4. Confidentiality</h3>
<p>The coach will keep what is shared in sessions confidential, except where disclosure is required by law or where there is a credible risk of harm to the client or others.</p>
<h3>5. No guarantee of results</h3>
<p>Coaching outcomes depend on the client's effort and circumstances. The coach makes no guarantee of any specific result.</p>
<h3>6. Term and termination</h3>
<p>Either party may end this engagement in writing at any time. Sessions already paid for and not yet delivered will be honored or refunded at the coach's discretion.</p>
`.trim(),
    fields: [
      { id: 'coach-sig',   type: 'signature', label: 'Coach signature',   required: true, value: '', signerIndex: 0 },
      { id: 'coach-date',  type: 'date',      label: 'Date',              required: true, value: '', signerIndex: 0 },
      { id: 'client-sig',  type: 'signature', label: 'Client signature',  required: true, value: '', signerIndex: 1 },
      { id: 'client-date', type: 'date',      label: 'Date',              required: true, value: '', signerIndex: 1 },
    ],
  },
  {
    id: 'nda-mutual',
    category: 'Professional',
    name: 'Mutual Non-Disclosure Agreement',
    description: 'Two-way NDA for early conversations with prospects and partners.',
    suggestedSigners: 2,
    body: `
<h2>Mutual Non-Disclosure Agreement</h2>
<p>This agreement governs information exchanged between the two parties identified below in the course of evaluating a potential business relationship.</p>
<h3>1. Confidential information</h3>
<p>"Confidential information" means non-public information disclosed by either party that a reasonable person would understand to be confidential, including business plans, customer lists, financials, technical information, and proprietary methods. Information that is or becomes public, was already known to the receiving party, or is independently developed without reference to the disclosing party's information is excluded.</p>
<h3>2. Use and protection</h3>
<p>Each party will use the other's confidential information only to evaluate the potential relationship, will protect it with at least the same care it uses for its own similarly-sensitive information (and never less than reasonable care), and will not disclose it to any third party without prior written consent.</p>
<h3>3. Term</h3>
<p>The obligations in this agreement begin when information is disclosed and end three (3) years after the date of the last disclosure.</p>
<h3>4. No license</h3>
<p>Nothing here grants either party any rights in the other's confidential information beyond the limited use described above.</p>
<h3>5. Remedies</h3>
<p>Each party acknowledges that breach of this agreement may cause irreparable harm and that the non-breaching party is entitled to seek equitable relief in addition to any other remedies available.</p>
`.trim(),
    fields: [
      { id: 'p1-sig',  type: 'signature', label: 'Party 1 signature', required: true, value: '', signerIndex: 0 },
      { id: 'p1-date', type: 'date',      label: 'Date',              required: true, value: '', signerIndex: 0 },
      { id: 'p2-sig',  type: 'signature', label: 'Party 2 signature', required: true, value: '', signerIndex: 1 },
      { id: 'p2-date', type: 'date',      label: 'Date',              required: true, value: '', signerIndex: 1 },
    ],
  },

  // ─── General ────────────────────────────────────────────────────
  {
    id: 'cancellation-policy',
    category: 'General',
    name: 'Cancellation & No-Show Policy',
    description: 'Sets expectations on cancellations, late arrivals, and no-shows.',
    suggestedSigners: 1,
    body: `
<h2>Cancellation & No-Show Policy</h2>
<p>I understand and agree to the following policies:</p>
<ul>
<li><strong>24-hour notice.</strong> Cancellations made with less than 24 hours' notice may be charged at the full session rate.</li>
<li><strong>No-shows.</strong> Failing to show up without prior notice may be charged at the full session rate and may forfeit any deposit.</li>
<li><strong>Late arrivals.</strong> The session will end at its originally scheduled time. The full session rate still applies.</li>
<li><strong>Provider cancellations.</strong> If I need to cancel, I will offer a reschedule or full refund of any prepayment.</li>
</ul>
<p>By signing, I acknowledge I have read and accept this policy.</p>
`.trim(),
    fields: SIG_DATE,
  },
  {
    id: 'service-agreement',
    category: 'Professional',
    name: 'Service Agreement (Generic)',
    description: 'Light-touch service contract — scope, fees, term, IP, termination.',
    suggestedSigners: 2,
    body: `
<h2>Service Agreement</h2>
<h3>1. Scope of services</h3>
<p>The provider will deliver the services described in the most-recent written proposal accepted by both parties. Changes to scope require written agreement and may adjust fees and timeline.</p>
<h3>2. Fees and payment</h3>
<p>Fees are as stated in the accepted proposal. Invoices are due within fourteen (14) days unless otherwise agreed in writing. Late invoices may accrue interest at 1.5% per month or the maximum permitted by law, whichever is lower.</p>
<h3>3. Ownership and intellectual property</h3>
<p>Upon full payment, the client owns the deliverables produced specifically for them. The provider retains ownership of any pre-existing tools, templates, methods, and know-how used to produce the deliverables, and grants the client a non-exclusive license to use those elements as embedded in the deliverables.</p>
<h3>4. Confidentiality</h3>
<p>Each party will treat the other's non-public information as confidential and use it only for the purpose of this engagement.</p>
<h3>5. Term and termination</h3>
<p>This agreement begins on the date of last signature and continues until services are complete or either party terminates with fourteen (14) days' written notice. Fees for work performed up to the termination date remain due.</p>
<h3>6. Limitation of liability</h3>
<p>Each party's total liability arising out of this agreement is limited to the total fees paid in the three months immediately preceding the event giving rise to the claim. Neither party is liable for indirect, incidental, or consequential damages.</p>
`.trim(),
    fields: [
      { id: 'provider-sig',  type: 'signature', label: 'Provider signature', required: true, value: '', signerIndex: 0 },
      { id: 'provider-date', type: 'date',      label: 'Date',               required: true, value: '', signerIndex: 0 },
      { id: 'client-sig',    type: 'signature', label: 'Client signature',   required: true, value: '', signerIndex: 1 },
      { id: 'client-date',   type: 'date',      label: 'Date',               required: true, value: '', signerIndex: 1 },
    ],
  },
];

export const TEMPLATE_CATEGORIES = [
  'Fitness',
  'Wellness',
  'Beauty',
  'Coaching',
  'Professional',
  'General',
];

// Public list shape for the gallery (server-safe — no internal fields).
export function listTemplatesPublic() {
  return DOCUMENT_TEMPLATES.map((t) => ({
    id: t.id,
    category: t.category,
    name: t.name,
    description: t.description,
    suggestedSigners: t.suggestedSigners,
    bodyPreview: stripHtml(t.body).slice(0, 220),
    fieldCount: t.fields.length,
  }));
}

// Lookup by id with the full body + fields included. Used when the
// user picks a template and we clone it into a fresh document row.
export function findTemplate(id) {
  return DOCUMENT_TEMPLATES.find((t) => t.id === id) || null;
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
