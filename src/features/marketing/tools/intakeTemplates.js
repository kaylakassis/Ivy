// Client intake form templates (/tools/intake-form-templates). Plain data
// plus a plain-text renderer for Copy and Download. Slugs match the
// /for/<slug> pages. Unit tests: tests/tools-generators.test.mjs.

const CONTACT = (extra = []) => ({
  title: 'Contact details',
  questions: [
    'Full name',
    'Phone number',
    'Email address',
    'How do you prefer to be contacted? (text, email or phone call)',
    ...extra,
    'How did you hear about me?',
  ],
});

const POLICIES = (extra = []) => ({
  title: 'Policies and agreement',
  questions: [
    'I have read and agree to the cancellation policy.',
    ...extra,
    'Signature',
    'Date',
  ],
});

export const HEALTH_PRIVACY_NOTE = 'Health details are private. Only ask what you need to keep the client safe, store the answers securely, and check which privacy rules apply where you work.';

export const INTAKE_TEMPLATES = [
  {
    slug: 'massage-therapists',
    profession: 'Massage therapists',
    title: 'Massage therapy intake form',
    sections: [
      CONTACT(['Date of birth', 'Emergency contact: name and phone number']),
      {
        title: 'Your visit',
        questions: [
          'Have you had a professional massage before?',
          'What would you like help with today? (relaxation, sore muscles, recovery, stress, something else)',
          'Areas you would like me to focus on',
          'Areas you would like me to avoid',
          'Pressure you prefer: light, medium or firm',
        ],
      },
      {
        title: 'Health and safety',
        note: HEALTH_PRIVACY_NOTE,
        questions: [
          'Any medical conditions I should know about? (for example: high blood pressure, diabetes, a heart condition, blood clots)',
          'Any recent injuries, surgeries or procedures? If yes, when?',
          'Are you pregnant? If yes, how many weeks?',
          'Any medications that might affect how you feel touch or pressure?',
          'Allergies or sensitivities to oils, lotions or scents?',
          'Are you seeing a doctor or other provider for any of this? If yes, what for?',
        ],
      },
      {
        title: 'Preferences',
        questions: [
          'Music or quiet?',
          'Room temperature: warmer or cooler?',
          'Anything else that would help you feel comfortable?',
        ],
      },
      POLICIES([
        'I understand massage therapy is not a substitute for medical care, and I will tell my therapist about any changes to my health.',
        'I understand I can ask to change the pressure or stop the session at any time.',
      ]),
    ],
  },
  {
    slug: 'hair-stylists',
    profession: 'Hair stylists',
    title: 'Hair client intake form',
    sections: [
      CONTACT(),
      {
        title: 'Your hair goals',
        questions: [
          'What would you like to get done? (cut, color, highlights, treatment, styling)',
          'What do you love about your hair right now, and what would you change?',
          'Please attach or bring photos of looks you like, and any you do not.',
          'How much time do you spend styling your hair on a normal day?',
          'How often are you happy to come in for upkeep?',
        ],
      },
      {
        title: 'Hair history',
        questions: [
          'Has your hair been colored, lightened or chemically treated in the last year? If yes, what and when?',
          'Have you used box dye or henna?',
          'Any keratin, relaxer or perm treatments? When was the last one?',
          'Products you use now (shampoo, conditioner, styling, heat tools)',
        ],
      },
      {
        title: 'Health and safety',
        note: HEALTH_PRIVACY_NOTE,
        questions: [
          'Any scalp conditions or sensitivities?',
          'Any allergies, including to hair color or other products?',
          'Have you ever reacted to hair color? Would you like a patch test before color?',
        ],
      },
      {
        title: 'Preferences',
        questions: [
          'Chatty or quiet appointment?',
          'Anything else I should know?',
        ],
      },
      POLICIES([
        'I understand color results depend on my hair history and may take more than one appointment.',
        'I am happy for photos of my hair to be shared online. (yes / no)',
      ]),
    ],
  },
  {
    slug: 'personal-trainers',
    profession: 'Personal trainers',
    title: 'Personal training intake form',
    sections: [
      CONTACT(['Date of birth', 'Emergency contact: name and phone number']),
      {
        title: 'Goals',
        questions: [
          'What are your main goals? (strength, weight change, fitness, sport, mobility, feeling better)',
          'What would success look like in three months?',
          'What has worked for you before, and what has not?',
        ],
      },
      {
        title: 'Health and safety',
        note: `${HEALTH_PRIVACY_NOTE} If a client answers yes to any question here, ask them to check with their doctor before starting.`,
        questions: [
          'Has a doctor ever said you have a heart condition or high blood pressure?',
          'Do you ever feel chest pain, dizziness or faintness during activity?',
          'Any current or past injuries, joint problems or surgeries?',
          'Any medical conditions or medications that affect exercise?',
          'Are you pregnant or recently postpartum?',
          'Has a doctor told you to limit any kind of exercise?',
        ],
      },
      {
        title: 'Your routine',
        questions: [
          'How active are you right now, and what do you do?',
          'How many days a week can you train, and at what times?',
          'Where would you like to train? (gym, home, outdoors, online)',
          'How do you sleep, and how stressed are you lately? (scale of 1 to 10)',
        ],
      },
      {
        title: 'Preferences',
        questions: [
          'Exercises you enjoy, and any you would rather avoid',
          'How do you like to be coached? (gentle encouragement, direct and tough, somewhere in between)',
        ],
      },
      POLICIES([
        'I understand that exercise carries some risk of injury, and I will tell my trainer about any pain or changes to my health.',
        'I confirm my answers are true to the best of my knowledge.',
      ]),
    ],
  },
  {
    slug: 'coaches',
    profession: 'Coaches',
    title: 'Coaching client intake form',
    sections: [
      CONTACT(['Time zone']),
      {
        title: 'Where you are now',
        questions: [
          'What made you look for a coach right now?',
          'Briefly, what is going well in your work or life?',
          'What feels stuck or hard?',
          'Have you worked with a coach, mentor or therapist before? What helped?',
        ],
      },
      {
        title: 'Goals',
        questions: [
          'What would you like to be different in three months?',
          'How will you know our work together has been worth it?',
          'What might get in the way?',
        ],
      },
      {
        title: 'Working together',
        questions: [
          'How do you like to receive feedback? (direct, gentle, a mix)',
          'Between sessions, how would you like to stay in touch? (email, messages, none)',
          'Best days and times for sessions',
          'Anything else you would like me to know before we start?',
        ],
      },
      POLICIES([
        'I understand coaching is not therapy, medical, legal or financial advice.',
        'I understand what we talk about stays confidential, except where the law requires otherwise.',
      ]),
    ],
  },
  {
    slug: 'photographers',
    profession: 'Photographers',
    title: 'Photography client questionnaire',
    sections: [
      CONTACT(),
      {
        title: 'Your session',
        questions: [
          'What kind of session is this? (portraits, family, couple, wedding, brand, event, other)',
          'Date and time you have in mind',
          'Location, or would you like ideas?',
          'Who will be in the photos? (number of people, ages, pets)',
        ],
      },
      {
        title: 'Your vision',
        questions: [
          'Describe the feel you are after in a few words.',
          'Please share links or photos of images you love.',
          'Must-have shots or people',
          'Anything you are self-conscious about or would like me to avoid?',
          'Where will the photos be used? (home, social media, website, print)',
        ],
      },
      {
        title: 'Practical details',
        questions: [
          'Outfit plans or questions about what to wear',
          'Any accessibility needs for you or your guests?',
          'For events: a contact on the day, and a timeline if you have one',
        ],
      },
      POLICIES([
        'I understand the deposit holds my date and the balance is due before the session or delivery.',
        'I am happy for some of my photos to appear in your portfolio or online. (yes / no)',
      ]),
    ],
  },
  {
    slug: 'tutors',
    profession: 'Tutors',
    title: 'Tutoring student intake form',
    sections: [
      {
        title: 'Contact details',
        questions: [
          'Student name',
          'Student grade or year, and school',
          'Parent or guardian name (if the student is under 18)',
          'Phone number',
          'Email address',
          'How do you prefer to be contacted? (text, email or phone call)',
          'How did you hear about me?',
        ],
      },
      {
        title: 'Goals',
        questions: [
          'Which subject or subjects would you like help with?',
          'What is going well, and what feels hard right now?',
          'Any upcoming tests, exams or deadlines? When?',
          'What would a great result look like by the end of term?',
        ],
      },
      {
        title: 'Learning needs',
        note: 'Learning and health details are private. Ask only what helps you teach, store answers securely, and share them with no one without permission.',
        questions: [
          'Does the student have any learning differences, or an IEP, 504 plan or similar support at school?',
          'What helps the student focus and learn best?',
          'Anything that makes learning harder? (for example: long sessions, noise, screen time)',
        ],
      },
      {
        title: 'Scheduling and preferences',
        questions: [
          'Online or in person? If in person, where?',
          'Best days and times',
          'Would you like a short progress update after each session?',
          'For students under 18: who will be home or reachable during sessions?',
        ],
      },
      POLICIES([
        'I understand progress depends on regular sessions and practice between them.',
      ]),
    ],
  },
  {
    slug: 'estheticians',
    profession: 'Estheticians',
    title: 'Skin care client intake form',
    sections: [
      CONTACT(['Date of birth']),
      {
        title: 'Your skin',
        questions: [
          'What would you like to work on? (breakouts, dryness, sensitivity, aging, pigmentation, relaxation)',
          'How would you describe your skin? (dry, oily, combination, sensitive, not sure)',
          'Your current routine: cleanser, serums, moisturizer, sunscreen',
          'Have you had facials, peels, laser or injectables before? When was the last one?',
        ],
      },
      {
        title: 'Health and safety',
        note: HEALTH_PRIVACY_NOTE,
        questions: [
          'Are you using retinoids, acids or prescription skin treatments? Have you taken isotretinoin in the last year?',
          'Any allergies or sensitivities to products, ingredients or latex?',
          'Any skin conditions? (for example: eczema, rosacea, cold sores)',
          'Are you pregnant or breastfeeding?',
          'Any medical conditions or medications I should know about?',
          'Recent sun exposure, sunburn or tanning?',
        ],
      },
      {
        title: 'Preferences',
        questions: [
          'Scents you love or would rather avoid',
          'Chatty or quiet appointment?',
        ],
      },
      POLICIES([
        'I have answered the health questions truthfully and will tell my esthetician about any changes.',
        'I agree to before and after photos for my records. (yes / no)',
        'I am happy for those photos to be shared online without my face. (yes / no)',
      ]),
    ],
  },
  {
    slug: 'cleaners',
    profession: 'Cleaners',
    title: 'Home cleaning client intake form',
    sections: [
      CONTACT(['Service address']),
      {
        title: 'Your home',
        questions: [
          'Type of home and size (bedrooms and bathrooms)',
          'Rooms or areas that matter most to you',
          'Anything to skip or handle with care? (valuables, delicate surfaces, a home office)',
          'Pets at home? Will they be in or out during the clean?',
        ],
      },
      {
        title: 'Access',
        questions: [
          'How will I get in? (someone home, key, lockbox, door code)',
          'Alarm system details, if any',
          'Parking instructions',
        ],
      },
      {
        title: 'The clean',
        questions: [
          'How often would you like cleaning? (one time, weekly, every two weeks, monthly)',
          'Should I bring supplies, or use yours?',
          'Any allergies or sensitivities to cleaning products or scents?',
          'Preferred days and times',
        ],
      },
      POLICIES([
        'I understand that if no one can let my cleaner in at the agreed time, the visit counts as a missed visit.',
        'I will let my cleaner know about anything fragile or valuable before the visit.',
      ]),
    ],
  },
];

export const INTAKE_BY_SLUG = Object.fromEntries(INTAKE_TEMPLATES.map((t) => [t.slug, t]));

// Plain text for Copy / Download. Notes for the business owner are
// marked so they are easy to delete before sending.
export function intakeTemplateText(template) {
  const out = [template.title, ''];
  for (const s of template.sections) {
    out.push(s.title);
    if (s.note) out.push(`(Note for you: ${s.note})`);
    for (const q of s.questions) out.push(`• ${q}`);
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

export function intakeFileName(template) {
  return `intake-form-${template.slug}.txt`;
}
