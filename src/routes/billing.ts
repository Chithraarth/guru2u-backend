import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, sql, isNull, and } from "drizzle-orm";
import { db, usersTable, readingPurchasesTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  verifyProductPurchase,
  acknowledgeProductPurchase,
  consumeProductPurchase,
} from "../lib/googlePlay";

// Needs requireAuth — mount under the authenticated section.
const router: IRouter = Router();
// Public: Pub/Sub push calls this directly, with no Firebase auth token.
// Secured instead by the shared-secret query param — mount before requireAuth.
const webhookRouter: IRouter = Router();

// Maps each one-time product SKU to how many reading credits it grants. Add
// an entry here for every consumable product created in Play Console.
const READING_PACKS: Record<string, number> = {
  reading_pack_60: 60,
};

router.use("/billing", requireAuth);

const VerifyBody = z.object({
  purchaseToken: z.string().min(1),
  productId: z.string().min(1),
});

router.post("/billing/verify", async (req, res): Promise<void> => {
  const parsed = VerifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { purchaseToken, productId } = parsed.data;

  const scansGranted = READING_PACKS[productId];
  if (!scansGranted) {
    res.status(400).json({ error: "Unknown product" });
    return;
  }

  try {
    const status = await verifyProductPurchase(productId, purchaseToken);

    if (!status.isPurchased) {
      res.status(400).json({ error: "This purchase isn't valid." });
      return;
    }

    // The purchase was made with obfuscatedAccountId set to the buyer's
    // Firebase UID (see mobile purchase flow) — reject a token that doesn't
    // belong to the signed-in user, so one account's purchase can't be
    // replayed onto another.
    if (
      status.obfuscatedExternalAccountId &&
      status.obfuscatedExternalAccountId !== req.userId
    ) {
      res.status(403).json({ error: "This purchase belongs to a different account." });
      return;
    }

    if (status.acknowledgementState !== "acknowledged") {
      await acknowledgeProductPurchase(productId, purchaseToken);
    }

    const user = await grantReadingCredits(req.userId!, productId, purchaseToken, scansGranted);

    if (!status.alreadyConsumed) {
      await consumeProductPurchase(productId, purchaseToken);
    }

    res.json({ scansRemaining: user.scansRemaining });
  } catch (err) {
    req.log.error({ err }, "Failed to verify Play purchase");
    res.status(500).json({ error: "Failed to verify purchase" });
  }
});

// Idempotent: the unique constraint on purchaseToken means re-verifying the
// same purchase (client retry, or both RTDN and the client reporting it) can
// only ever grant credits once.
async function grantReadingCredits(
  userId: string,
  productId: string,
  purchaseToken: string,
  scansGranted: number,
) {
  const inserted = await db
    .insert(readingPurchasesTable)
    .values({ userId, productId, purchaseToken, scansGranted })
    .onConflictDoNothing({ target: readingPurchasesTable.purchaseToken })
    .returning({ id: readingPurchasesTable.id });

  if (inserted.length > 0) {
    await db
      .update(usersTable)
      .set({ scansRemaining: sql`${usersTable.scansRemaining} + ${scansGranted}` })
      .where(eq(usersTable.id, userId));
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  return user;
}

// Called when Play reports a purchase as voided/refunded — reverses exactly
// the credits that specific purchase granted, and only once (guarded by
// revokedAt), floored at zero so it can't push the count negative if the
// user has already spent some of those credits.
async function revokeReadingCredits(purchaseToken: string) {
  const [purchase] = await db
    .select()
    .from(readingPurchasesTable)
    .where(eq(readingPurchasesTable.purchaseToken, purchaseToken));
  if (!purchase || purchase.revokedAt) return null;

  const [revoked] = await db
    .update(readingPurchasesTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(readingPurchasesTable.purchaseToken, purchaseToken),
        isNull(readingPurchasesTable.revokedAt),
      ),
    )
    .returning();
  if (!revoked) return null;

  await db
    .update(usersTable)
    .set({
      scansRemaining: sql`GREATEST(${usersTable.scansRemaining} - ${purchase.scansGranted}, 0)`,
    })
    .where(eq(usersTable.id, purchase.userId));

  return purchase.userId;
}

// Pub/Sub push endpoint for Real-time Developer Notifications. Configure the
// push subscription's endpoint URL as .../api/billing/rtdn?token=<RTDN_WEBHOOK_SECRET>
// so we can confirm the request actually came from our own Pub/Sub subscription.
webhookRouter.post("/billing/rtdn", async (req, res): Promise<void> => {
  const expectedSecret = process.env.RTDN_WEBHOOK_SECRET;
  if (!expectedSecret || req.query.token !== expectedSecret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Ack immediately — Pub/Sub retries on anything but a 2xx, and we don't
  // want a slow/failed Play API call to cause redelivery storms. Errors are
  // logged for follow-up rather than surfaced to Pub/Sub.
  res.status(204).end();

  try {
    const messageData = (req.body as { message?: { data?: string } })?.message?.data;
    if (!messageData) return;

    const decoded = JSON.parse(Buffer.from(messageData, "base64").toString("utf8")) as {
      oneTimeProductNotification?: {
        notificationType?: number;
        purchaseToken?: string;
        sku?: string;
      };
    };
    const notification = decoded.oneTimeProductNotification;
    const purchaseToken = notification?.purchaseToken;
    if (!purchaseToken) return;

    // ONE_TIME_PRODUCT_CANCELED = 2 (refunded/voided). We only react to
    // voids here — a fresh purchase is credited via the client's own
    // /billing/verify call, which has the signed-in user's context that
    // this webhook doesn't.
    if (notification?.notificationType === 2) {
      await revokeReadingCredits(purchaseToken);
    }
  } catch (err) {
    req.log.error({ err }, "Failed to process RTDN notification");
  }
});

export default router;
export { webhookRouter };
