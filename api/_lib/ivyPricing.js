// List prices per million tokens for the models Ivy may run on:
// [input, output, cache read, cache write]. Used only to estimate spend on
// the Readiness page from the tokens recorded in ivy_usage. Update when the
// provider's price list changes (last checked against it: 2026-11-16).
//
// Cache write is the ONE-HOUR rate (2x input). Ivy's shared instructions and
// tool list are cached for an hour and make up nearly all of what she
// writes; the small 5-minute write for the conversation so far is priced the
// same here, so the estimate leans slightly high rather than low.
export const MODEL_PRICES = {
  'claude-opus-5-5': [4, 20, 0.2, 8],
  'claude-opus-5': [5, 25, 0.5, 10],
  'claude-sonnet-5-5': [2, 10, 0.1, 4],
  'claude-sonnet-5': [2, 10, 0.2, 4],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.2],
};
