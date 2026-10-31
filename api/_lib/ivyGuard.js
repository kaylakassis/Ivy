// Content guard for the Ivy chat: a conservative, pattern-based screen for
// the handful of categories Ivy must never engage with (sexual content
// involving minors, instructions for weapons / explosives / poisons,
// self-harm instructions, explicit requests for sexual content or hate
// speech).
//
// Defence in depth, not the primary layer. The model's own refusal, driven
// by the system prompt's "decline in one friendly line" rule, is what handles
// the long tail; this screen catches the obvious cases before any model call
// (screenOwnerPrompt) and on the assembled reply (screenReply) so that an
// unusually phrased request, or a model slip, still ends in the fixed line
// below rather than disallowed text in a business owner's chat.
//
// Tuned for a very low false-positive rate: every pattern needs an intent
// word near a category term, terms are word-bounded, and ordinary business
// vocabulary ("kids yoga class", "bomb review", "kill it this quarter",
// "explosive growth", "a client mentioned suicide") passes.

export const GUARD_REPLY = "I can't help with that. I'm here for your business: clients, bookings, invoices, messages, and your website.";

const MINOR = String.raw`(?:child|children|kid|kids|minor|minors|underage|under-age|preteen|pre-teen|toddler|toddlers|infant|schoolgirl|schoolboy|\d{1,2}[- ]year[- ]olds?)`;
const SEXUAL = String.raw`(?:sex|sexual|sexually|sexy|nude|nudes|naked|porn|pornographic|erotic|erotica|explicit|xxx|fetish)`;

// [pattern, reason]. Each pattern is tested against the whole text once.
const CATEGORIES = [
  // Sexual content involving minors: a minor term and a sexual term close
  // together, in either order.
  [new RegExp(String.raw`\b${MINOR}\b[^.!?\n]{0,60}\b${SEXUAL}\b`, 'i'), 'sexual-minors'],
  [new RegExp(String.raw`\b${SEXUAL}\b[^.!?\n]{0,60}\b${MINOR}\b`, 'i'), 'sexual-minors'],

  // Weapons / explosives / poisons: making, acquiring or using them.
  [/\b(?:make|build|assemble|construct|synthesi[sz]e|manufacture|cook|produce|create)\b[^.!?\n]{0,30}\b(?:a |an |the |some )?(?:bomb|bombs|explosive|explosives|pipe bomb|ied|molotov|napalm|thermite|nerve agent|sarin|ricin|cyanide|chlorine gas|mustard gas|methamphetamine|meth lab|silencer|suppressor|ghost gun|untraceable (?:gun|firearm|weapon))\b/i, 'weapons'],
  [/\b(?:bomb|explosive|explosives|ricin|sarin|napalm|thermite|nerve agent|pipe bomb|ghost gun)\b[^.!?\n]{0,30}\b(?:recipe|recipes|instructions|blueprint|blueprints|synthesis|how[- ]to|tutorial|step[- ]by[- ]step)\b/i, 'weapons'],
  [/\bhow (?:to|do i|can i|would i|could i)\b[^.!?\n]{0,30}\b(?:poison|kill|murder)\b[^.!?\n]{0,20}\b(?:someone|a person|people|my (?:wife|husband|boss|client|neighbou?r|partner|ex|mother|father|parents)|him|her|them)\b/i, 'violence'],
  [/\b(?:poison|poisoning)\b[^.!?\n]{0,20}\b(?:someone|a person|my (?:wife|husband|boss|client|neighbou?r|partner|ex))\b[^.!?\n]{0,40}\b(?:without|undetect|untraceable|getting caught)\b/i, 'violence'],
  [/\buntraceable (?:poison|poisons)\b/i, 'violence'],

  // Self-harm instructions: first-person harm with a how / method framing.
  [/\b(?:how (?:to|do i|can i|should i)|best way to|easiest way to|painless(?:ly)? way to|painless(?:ly)?|methods? (?:to|of|for))\b[^.!?\n]{0,40}\b(?:kill myself|end my (?:own )?life|take my own life|hurt myself|cut myself|harm myself|commit suicide|overdose on)\b/i, 'self-harm'],
  [/\b(?:kill myself|end my (?:own )?life|take my own life|commit suicide)\b[^.!?\n]{0,40}\b(?:how|which (?:pills|method)|how many|painless|quick(?:est|ly)?)\b/i, 'self-harm'],

  // Explicit requests for sexual content.
  [/\b(?:write|generate|create|make|give me|send me|describe|tell me|compose|draft|roleplay|role-play)\b[^.!?\n]{0,40}\b(?:porn|pornographic|erotica|erotic (?:story|scene|roleplay|fiction)|sex (?:story|scene)|explicit sex|smut|hardcore sex|xxx|sexts?|sexting)\b/i, 'sexual'],
  [/\b(?:sext|sexting|talk dirty|dirty talk)\b[^.!?\n]{0,30}\b(?:to me|with me|for me)\b/i, 'sexual'],

  // Explicit requests for hate speech.
  [/\b(?:write|generate|create|make|give me|tell me|compose|draft|list)\b[^.!?\n]{0,40}\b(?:racist|antisemitic|anti-semitic|homophobic|transphobic|islamophobic|white supremacist|neo-nazi|nazi)\b[^.!?\n]{0,40}\b(?:joke|jokes|rant|rants|speech|manifesto|post|posts|meme|memes|content|propaganda|tweet|tweets|slur|slurs|song|poem)\b/i, 'hate'],
  [/\b(?:write|generate|create|give me|tell me|list|say)\b[^.!?\n]{0,30}\b(?:racial|ethnic|homophobic|antisemitic|anti-semitic) slurs?\b/i, 'hate'],
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
  return { text: GUARD_REPLY, mode: 'live', error: null, guarded: reason || true };
}
