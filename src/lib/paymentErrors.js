// Messages for a failed payment return (?payment=error&reason=<code>).
//
// The booking page and the public invoice page used to print whatever
// text was in the URL (?msg=...), so anyone could send a client a real
// Ivy link that showed words of their choosing ("Payment failed, call
// this number..."). Now the URL only carries a short code and the page
// picks one of these fixed messages. An unknown code, or an old link that
// still has ?msg=, gets the generic message; msg is never shown.
//
// Codes are set server-side in api/finance/paypal-return.js.
export const GENERIC_PAYMENT_ERROR = 'Something went wrong with the payment. Please try again.';

export const PAYMENT_ERROR_MESSAGES = Object.freeze({
  declined: 'Your payment was declined. Please try a different card or payment method.',
  unavailable: "This business can't take this payment method right now. Please try another way to pay.",
  failed: "Your payment didn't go through. Please try again.",
});

export function paymentErrorMessage(code) {
  const key = typeof code === 'string' ? code : '';
  return Object.prototype.hasOwnProperty.call(PAYMENT_ERROR_MESSAGES, key)
    ? PAYMENT_ERROR_MESSAGES[key]
    : GENERIC_PAYMENT_ERROR;
}
