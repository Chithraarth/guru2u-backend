import { Router, type IRouter } from "express";
import { sql, eq } from "drizzle-orm";
import {
  db,
  usersTable,
  billingGrantsTable,
  shareEventsTable,
} from "@workspace/db";
import { getStripeClient } from "../stripeClient";
import { requireAuth } from "../middlewares/requireAuth";
import { getEntitlement } from "../lib/entitlements";
import { listPlanPrices } from "../lib/stripePlans";

const router: IRouter = Router();

function webBaseUrl(): string {
  const url = process.env.PUBLIC_BASE_URL;
  if (!url) throw new Error("PUBLIC_BASE_URL environment variable is required");
  return url.replace(/\/+$/, "");
}

// Public: list plans (products with prices tagged with a planKey)
router.get("/billing/plans", async (_req, res): Promise<void> => {
  const plans = await listPlanPrices();
  res.json({
    data: plans.map((p) => ({
      product_id: p.productId,
      name: p.name,
      description: p.description,
      metadata: p.metadata,
      price_id: p.priceId,
      unit_amount: p.unitAmount,
      currency: p.currency,
      interval: p.interval,
    })),
  });
});

// Authenticated: current subscription / usage status
router.get("/billing/status", requireAuth, async (req, res): Promise<void> => {
  const ent = await getEntitlement(req.userId!);
  res.json(ent);
});

async function getOrCreateCustomer(userId: string): Promise<string> {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (user?.stripeCustomerId) return user.stripeCustomerId;

  // Populated by requireAuth's JIT user-provisioning from the Firebase ID token.
  const email = user?.email ?? undefined;

  const stripe = getStripeClient();
  const customer = await stripe.customers.create({
    email,
    metadata: { userId },
  });
  await db
    .update(usersTable)
    .set({ stripeCustomerId: customer.id, email: email ?? null })
    .where(eq(usersTable.id, userId));
  return customer.id;
}

// Return URLs. Mobile checkouts can't land back on the web SPA, so they
// return to a server-rendered page that also settles one-off purchases.
function returnUrls(platform: string | undefined, webParams: { success: string; cancel: string }) {
  if (platform === "mobile") {
    return {
      success_url: `${webBaseUrl()}/api/billing/mobile-return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${webBaseUrl()}/api/billing/mobile-return?cancelled=1`,
    };
  }
  return {
    success_url: `${webBaseUrl()}/pricing?${webParams.success}`,
    cancel_url: `${webBaseUrl()}/pricing?${webParams.cancel}`,
  };
}

// Subscription checkout
router.post("/billing/checkout", requireAuth, async (req, res): Promise<void> => {
  const priceId = String(req.body?.priceId ?? "");
  if (!priceId) {
    res.status(400).json({ error: "priceId is required" });
    return;
  }
  const customerId = await getOrCreateCustomer(req.userId!);
  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    mode: "subscription",
    ...returnUrls(req.body?.platform, {
      success: "status=success",
      cancel: "status=cancelled",
    }),
  });
  res.json({ url: session.url });
});

// One-off extra reading purchase (Rs 33 each)
router.post("/billing/extra-checkout", requireAuth, async (req, res): Promise<void> => {
  const qty = Math.min(Math.max(Number(req.body?.quantity ?? 1), 1), 20);
  const customerId = await getOrCreateCustomer(req.userId!);

  const plans = await listPlanPrices();
  const priceId = plans.find((p) => p.metadata.planKey === "extra_reading")?.priceId;
  if (!priceId) {
    res.status(500).json({ error: "Extra reading price not configured" });
    return;
  }

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    line_items: [{ price: priceId, quantity: qty }],
    mode: "payment",
    metadata: { userId: req.userId!, type: "extra_reading", quantity: String(qty) },
    ...returnUrls(req.body?.platform, {
      success: "status=extra_success&session_id={CHECKOUT_SESSION_ID}",
      cancel: "status=cancelled",
    }),
  });
  res.json({ url: session.url });
});

// Grants credits for a paid extra-reading session (idempotent via billing_grants).
async function settleExtraReadingSession(sessionId: string): Promise<boolean> {
  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (
    session.payment_status !== "paid" ||
    session.metadata?.type !== "extra_reading" ||
    !session.metadata?.userId
  ) {
    return false;
  }
  const qty = Number(session.metadata?.quantity ?? 1);
  const userId = session.metadata.userId;
  const inserted = await db
    .insert(billingGrantsTable)
    .values({ sessionId, userId, credits: qty })
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) {
    await db.execute(
      sql`UPDATE users SET extra_credits = extra_credits + ${qty} WHERE id = ${userId}`,
    );
  }
  return true;
}

// Landing page for checkouts started from the mobile app. Settles one-off
// extra-reading purchases server-side (the app has no web session to call
// /billing/confirm), then tells the user to return to the app.
// Session ids are unguessable and granting is idempotent, so no auth is needed.
router.get("/billing/mobile-return", async (req, res): Promise<void> => {
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
  const cancelled = req.query.cancelled === "1";
  let heading = "Payment complete";
  let body = "You're all set. Close this window and return to the app.";
  if (cancelled) {
    heading = "Checkout cancelled";
    body = "No charge was made. Close this window and return to the app.";
  } else if (sessionId) {
    try {
      await settleExtraReadingSession(sessionId);
    } catch {
      heading = "Almost there";
      body = "We couldn't verify the payment yet. Your purchase will appear in the app shortly.";
    }
  }
  res
    .status(200)
    .type("html")
    .send(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${heading}</title></head>` +
        `<body style="font-family: system-ui, sans-serif; background:#0e0812; color:#f2f0f5; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; text-align:center;">` +
        `<div style="padding:24px; max-width:360px;"><h1 style="font-size:22px;">${heading}</h1><p style="color:#a99cba; line-height:1.5;">${body}</p></div></body></html>`,
    );
});

// Confirm a one-off purchase and grant credits (idempotent)
router.post("/billing/confirm", requireAuth, async (req, res): Promise<void> => {
  const sessionId = String(req.body?.sessionId ?? "");
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }
  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (
    session.payment_status !== "paid" ||
    session.metadata?.type !== "extra_reading" ||
    session.metadata?.userId !== req.userId
  ) {
    res.status(400).json({ error: "Invalid or unpaid session" });
    return;
  }
  const qty = Number(session.metadata?.quantity ?? 1);

  const inserted = await db
    .insert(billingGrantsTable)
    .values({ sessionId, userId: req.userId!, credits: qty })
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) {
    await db.execute(
      sql`UPDATE users SET extra_credits = extra_credits + ${qty} WHERE id = ${req.userId}`,
    );
  }
  const ent = await getEntitlement(req.userId!);
  res.json(ent);
});

const SHARE_PLATFORMS = [
  "facebook",
  "instagram",
  "whatsapp",
  "twitter",
  "tiktok",
  "linkedin",
  "telegram",
];
const SHARES_REQUIRED = 3;

// Record a social share (one per platform per user)
router.post("/billing/share", requireAuth, async (req, res): Promise<void> => {
  const platform = String(req.body?.platform ?? "").toLowerCase();
  if (!SHARE_PLATFORMS.includes(platform)) {
    res.status(400).json({ error: "Unknown platform" });
    return;
  }
  await db
    .insert(shareEventsTable)
    .values({ userId: req.userId!, platform })
    .onConflictDoNothing();
  const rows = await db
    .select({ platform: shareEventsTable.platform })
    .from(shareEventsTable)
    .where(eq(shareEventsTable.userId, req.userId!));
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.userId!));
  res.json({
    platforms: rows.map((r) => r.platform),
    required: SHARES_REQUIRED,
    claimed: Boolean(user?.shareRewardClaimedAt),
  });
});

// Share-reward summary
router.get("/billing/share", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select({ platform: shareEventsTable.platform })
    .from(shareEventsTable)
    .where(eq(shareEventsTable.userId, req.userId!));
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.userId!));
  res.json({
    platforms: rows.map((r) => r.platform),
    required: SHARES_REQUIRED,
    claimed: Boolean(user?.shareRewardClaimedAt),
  });
});

// Claim the share reward: grants 30 days of unlimited readings by setting
// users.free_until directly. One redemption per user, enforced atomically.
router.post(
  "/billing/claim-free-month",
  requireAuth,
  async (req, res): Promise<void> => {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, req.userId!));
    if (user?.shareRewardClaimedAt) {
      res.status(400).json({ error: "You've already claimed your free month." });
      return;
    }
    // Server-side validation: shares must be on distinct platforms we know
    // about (the composite PK already dedupes user+platform).
    const rows = await db
      .select({ platform: shareEventsTable.platform })
      .from(shareEventsTable)
      .where(eq(shareEventsTable.userId, req.userId!));
    const validCount = rows.filter((r) =>
      SHARE_PLATFORMS.includes(r.platform),
    ).length;
    if (validCount < SHARES_REQUIRED) {
      res.status(400).json({
        error: `Share on ${SHARES_REQUIRED} platforms first (${validCount}/${SHARES_REQUIRED} done).`,
      });
      return;
    }

    // Atomic single-redemption guard: only succeeds if not yet claimed.
    const updated = await db.execute(
      sql`
        UPDATE users
        SET free_until = now() + interval '30 days',
            share_reward_claimed_at = now()
        WHERE id = ${req.userId} AND share_reward_claimed_at IS NULL
        RETURNING free_until
      `,
    );
    if (updated.rows.length === 0) {
      res.status(400).json({ error: "You've already claimed your free month." });
      return;
    }
    const ent = await getEntitlement(req.userId!);
    res.json(ent);
  },
);

// Customer portal (manage / cancel subscription)
router.post("/billing/portal", requireAuth, async (req, res): Promise<void> => {
  const customerId = await getOrCreateCustomer(req.userId!);
  const stripe = getStripeClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${webBaseUrl()}/pricing`,
  });
  res.json({ url: session.url });
});

export default router;
