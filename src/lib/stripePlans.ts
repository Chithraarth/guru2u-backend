import type Stripe from 'stripe';
import { getStripeClient } from '../stripeClient';

export interface PlanPrice {
  productId: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  priceId: string;
  unitAmount: number | null;
  currency: string;
  interval: string | null;
}

/**
 * Active prices whose product carries a `planKey` metadata tag, sorted by
 * amount ascending. Shared by the public plans listing and the extra-reading
 * checkout price lookup so both stay in sync with one Stripe API call shape.
 */
export async function listPlanPrices(): Promise<PlanPrice[]> {
  const stripe = getStripeClient();
  const prices = await stripe.prices.list({
    active: true,
    expand: ['data.product'],
    limit: 100,
  });

  return prices.data
    .filter(
      (price): price is Stripe.Price & { product: Stripe.Product } =>
        typeof price.product !== 'string' &&
        !price.product.deleted &&
        Boolean((price.product as Stripe.Product).metadata?.planKey),
    )
    .map((price) => ({
      productId: price.product.id,
      name: price.product.name,
      description: price.product.description,
      metadata: price.product.metadata,
      priceId: price.id,
      unitAmount: price.unit_amount,
      currency: price.currency,
      interval: price.recurring?.interval ?? null,
    }))
    .sort((a, b) => (a.unitAmount ?? 0) - (b.unitAmount ?? 0));
}
