import { getStripeClient } from './stripeClient';
import { logger } from './lib/logger';

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        'STRIPE WEBHOOK ERROR: Payload must be a Buffer. ' +
        'Received type: ' + typeof payload + '. ' +
        'This usually means express.json() parsed the body before reaching this handler. ' +
        'FIX: Ensure webhook route is registered BEFORE app.use(express.json()).'
      );
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET environment variable is required');
    }

    // Entitlements are read live from Stripe (see lib/entitlements.ts), so no
    // local mirror needs updating here. Verifying the signature and logging
    // the event gives a place to hook in event-specific handling later.
    const event = getStripeClient().webhooks.constructEvent(payload, signature, webhookSecret);
    logger.info({ type: event.type }, 'Stripe webhook received');
  }
}
