// Shared helpers for Ivy OS-side subscription billing (the platform charging
// workspace owners). Per-workspace customer Stripe is unrelated - see
// api/finance/* for that path.

// Map Stripe's subscription.status enum onto our workspaces.subscription_status
// column. We collapse Stripe's near-terminal states ('canceled', 'unpaid',
// 'incomplete_expired') to a single 'cancelled' so the Paywall's
// already-trialed branch fires for all three.
export function mapStripeStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'trialing':              return 'trialing';
    case 'active':                return 'active';
    case 'past_due':              return 'past_due';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':    return 'cancelled';
    case 'incomplete':            return 'incomplete';
    default:                      return 'inactive';
  }
}
