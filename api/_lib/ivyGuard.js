// Content guard for the Ivy chat: a conservative, pattern-based screen for
// the handful of categories Ivy must never engage with (sexual content
// involving minors, instructions for weapons / explosives / poisons or for
// hurting someone, self-harm methods, explicit sexual content, hate speech).
//
// Defence in depth, not the primary layer. The model's own refusal, driven
// by the system prompt's rule, handles the long tail; this screen catches
// the obvious cases before any model call (screenOwnerPrompt) and on the
// assembled reply (screenReply), so an oddly phrased request or a model slip
// still ends in a fixed line instead of disallowed text.
//
// Tuned for a near-zero false-positive rate, because a wrongly blocked
// question costs an owner's trust too. Every pattern needs an explicit ask
// (write / make / how do I...) right next to the harmful object, and the
// object list is narrow. Ordinary small-business language must pass:
// bath bombs and hot cocoa bombs, a naked cake, nude nail colours, kids'
// classes, "explosive growth", "kill it at the pitch", "kill them with
// kindness", a therapist describing what a client said, a post condemning
// racist jokes. tests/ivy-approval.test.mjs holds both lists.

export const GUARD_REPLY = "I can't help with that. I'm here for your business: clients, bookings, invoices, messages, and your website.";

// Someone asking how to hurt themselves gets care, not a business brush-off.
export const SELF_HARM_REPLY = "I'm really sorry you're feeling this way, and I can't help with that. You don't have to go through it alone: in the US you can call or text 988 to reach the Suicide and Crisis Lifeline any time, and outside the US your local emergency number or findahelpline.com can connect you with someone right now.";

const ASK = String.raw`(?:write|generate|create|make|produce|draw|show me|send me|give me|describe|tell me|compose|draft|roleplay|role-play|pretend)`;
const MINOR = String.raw`(?:child|children|kid|kids|minor|minors|underage|under-age|preteen|pre-teen|toddler|toddlers|schoolgirl|schoolboy|(?:[1-9]|1[0-7])[- ]year[- ]olds?)`;
const PROTECTIVE = String.raw`(?!.*\b(?:abuse|prevention|preventing|awareness|safeguarding|protection|protecting|survivors?|grooming signs|warning signs)\b)`;
const SEXUAL_STRONG = String.raw`(?:sexual|sexually explicit|porn|pornographic|erotic|erotica|xxx|fetish|nudes|sex scene|sex story)`;

// Treats as weapons only the bomb that is not a bath, cocoa, seed... bomb.
const BOMB = String.raw`(?<!\b(?:bath|cocoa|chocolate|hot chocolate|seed|glitter|flavou?r|cocktail|smoke|colou?r|confetti|photo|truth|love|calorie|cake|cookie|cupcake|candy|fizz|shower|tea|cheese|f|f-|photo-|bath-)\s?)\bbombs?\b`;
const WEAPON_OBJECT = String.raw`(?:${BOMB}|pipe bomb|ied|molotov(?: cocktail)?|napalm|thermite|nerve agent|sarin|ricin|explosives|explosive device|chlorine gas|mustard gas|methamphetamine|meth lab|ghost gun|untraceable (?:gun|firearm|weapon))`;

const TARGET = String.raw`(?:someone|somebody|a person|people|my (?:wife|husband|boss|client|neighbou?r|partner|ex|mother|father|mom|dad|parents|coworker|co-worker|employee)|him|her|them)`;

// [pattern, reason]. Each pattern is tested against the whole text once.
const CATEGORIES = [
  // Sexual content involving minors: an explicit ask, a minor, and a
  // strongly sexual term together in one sentence.
  // Child-protection work (abuse prevention, safeguarding, survivor
  // support) is ordinary business for counsellors and educators; the model
  // still applies its own judgement to those.
  [new RegExp(String.raw`^${PROTECTIVE}.*\b${ASK}\b[^.!?\n]{0,60}\b${MINOR}\b[^.!?\n]{0,60}\b${SEXUAL_STRONG}\b`, 'i'), 'sexual-minors'],
  [new RegExp(String.raw`^${PROTECTIVE}.*\b${ASK}\b[^.!?\n]{0,60}\b${SEXUAL_STRONG}\b[^.!?\n]{0,60}\b${MINOR}\b`, 'i'), 'sexual-minors'],

  // Weapons / explosives / poisons: making or acquiring them.
  [new RegExp(String.raw`\b(?:make|build|assemble|construct|synthesi[sz]e|manufacture|cook|produce)\b[^.!?\n]{0,25}\b(?:a |an |the |some |my own )?${WEAPON_OBJECT}`, 'i'), 'weapons'],
  [new RegExp(String.raw`${WEAPON_OBJECT}[^.!?\n]{0,25}\b(?:recipe|recipes|instructions|blueprint|blueprints|synthesis|step[- ]by[- ]step)\b`, 'i'), 'weapons'],
  [new RegExp(String.raw`\b(?:recipe|recipes|instructions|blueprint|blueprints|steps?|guide|tutorial)\s+(?:for|to make|on making|to build|for making)\s+(?:a |an |the |some )?${WEAPON_OBJECT}`, 'i'), 'weapons'],

  // Hurting a specific person. "kill it", "kill them with kindness" pass.
  [new RegExp(String.raw`\bhow (?:to|do i|can i|would i|could i|should i)\s+(?:poison|murder|kill)\s+${TARGET}\b(?!\s+with\s+kindness)`, 'i'), 'violence'],
  [/\buntraceable (?:poison|poisons)\b/i, 'violence'],

  // Self-harm methods: a first-person how / method ask. A therapist relaying
  // what a client said ("my client said she wants to end her life") passes.
  [/\b(?:how (?:to|do i|can i|should i)|best way to|easiest way to|quickest way to|painless(?:ly)? way to|methods? (?:to|of|for))\s+(?:\w+\s+){0,3}(?:kill myself|end my (?:own )?life|take my own life|hurt myself|cut myself|harm myself|commit suicide|overdose)\b/i, 'self-harm'],
  [/\bhow many (?:\w+\s+){0,2}(?:pills|tablets)\b[^.!?\n]{0,30}\b(?:to die|to kill myself|to overdose|for an overdose|would kill me)\b/i, 'self-harm'],

  // Explicit sexual content.
  [new RegExp(String.raw`\b${ASK}\b[^.!?\n]{0,30}\b(?:porn|pornographic|erotica|erotic (?:story|scene|roleplay|fiction)|sex (?:story|scene)|explicit sex|smut|hardcore sex|xxx)\b`, 'i'), 'sexual'],
  [/\b(?:sext|talk dirty) (?:to|with) me\b/i, 'sexual'],

  // Hate speech: an ask directly followed by the hateful content. "Write a
  // post condemning racist jokes" passes (the ask is not next to it).
  [/\b(?:write|tell|give|make|generate|say|list)(?: me)?(?: a| some| an| more| \d+)?\s+(?:racist|antisemitic|anti-semitic|homophobic|transphobic|islamophobic|white supremacist|neo-nazi|nazi)\s+(?:joke|jokes|rant|rants|speech|manifesto|meme|memes|propaganda|slur|slurs|song|poem|insult|insults)\b/i, 'hate'],
  [/\b(?:write|tell|give|list|say)(?: me)?(?: a| some| the)?\s+(?:racial|ethnic|homophobic|antisemitic|anti-semitic) slurs?\b/i, 'hate'],
];

function screen(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  if (!t) return { blocked: false, reason: null };
  for (const [re, reason] of CATEGORIES) {
    if (re.test(t)) return { blocked: true, reason };
  }
  return { blocked: false, reason: null };
}

// The owner's message, before any model call.
export function screenOwnerPrompt(text) {
  return screen(text);
}

// Ivy's assembled reply, before it is persisted / shown.
export function screenReply(text) {
  return screen(text);
}

// The reply object the Ivy endpoints persist when either screen trips. Shaped
// like generateReply's return so finishTurn and the client need no special
// case; mode stays 'live' so the dock shows no "limited mode" banner.
export function guardedReply(reason) {
  const text = reason === 'self-harm' ? SELF_HARM_REPLY : GUARD_REPLY;
  return { text, mode: 'live', error: null, guarded: reason || true };
}
