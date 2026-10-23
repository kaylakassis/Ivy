// List prices per million tokens for the models Ivy may run on:
// [input, output, cache read, cache write]. Used only to estimate spend on
// the Readiness page from the tokens recorded in ivy_usage. Update when the
// provider's price list changes.
export const MODEL_PRICES = {
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-opus-5': [5, 25, 0.5, 6.25],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5],
  'claude-sonnet-5': [2, 10, 0.2, 2.5],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
};
