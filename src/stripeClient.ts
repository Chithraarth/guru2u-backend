import Stripe from 'stripe';

let _stripe: Stripe | null = null;

/** Returns a cached Stripe client authenticated with STRIPE_SECRET_KEY. */
export function getStripeClient(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY environment variable is required');
  }
  _stripe = new Stripe(key);
  return _stripe;
}
