import { sql, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import type Stripe from "stripe";
import { getStripeClient } from "../stripeClient";

// Any drizzle executor (db or a transaction) — enough surface for our queries.
export type PlanKey = "monthly" | "yearly_basic" | "yearly_unlimited" | null;

export interface Entitlement {
  planKey: PlanKey;
  planName: string | null;
  dailyLimit: number | null; // null = unlimited
  usedToday: number;
  extraCredits: number;
  freeUntil: string | null;
  canRead: boolean;
  reason: "ok" | "use_credit" | "no_plan" | "limit_reached";
}

const PLAN_LIMITS: Record<string, number | null> = {
  monthly: 10,
  yearly_basic: 5,
  yearly_unlimited: null,
};

export async function getEntitlement(
  userId: string,
  dbx: Executor = db,
): Promise<Entitlement> {
  const [user] = await dbx
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  const extraCredits = user?.extraCredits ?? 0;
  const freeUntil = user?.freeUntil ?? null;

  // Count today's readings (server-day, UTC)
  const usage = await dbx.execute(
    sql`SELECT count(*)::int AS n FROM readings WHERE user_id = ${userId} AND created_at >= date_trunc('day', now())`,
  );
  const usedToday = Number((usage.rows[0] as { n: number } | undefined)?.n ?? 0);

  // Promotional free period => unlimited
  if (freeUntil && new Date(freeUntil) > new Date()) {
    return {
      planKey: null,
      planName: "Free month",
      dailyLimit: null,
      usedToday,
      extraCredits,
      freeUntil: freeUntil.toISOString(),
      canRead: true,
      reason: "ok",
    };
  }

  // Find the active subscription via a live Stripe lookup
  let planKey: PlanKey = null;
  let planName: string | null = null;
  if (user?.stripeCustomerId) {
    const subs = await getStripeClient().subscriptions.list({
      customer: user.stripeCustomerId,
      status: "all",
      expand: ["data.items.data.price.product"],
      limit: 10,
    });
    const active = subs.data.find(
      (s) => s.status === "active" || s.status === "trialing",
    );
    const price = active?.items.data[0]?.price;
    const product =
      price && typeof price.product !== "string" && !price.product.deleted
        ? (price.product as Stripe.Product)
        : null;
    if (product?.metadata?.planKey) {
      planKey = product.metadata.planKey as PlanKey;
      planName = product.name;
    }
  }

  const dailyLimit = planKey ? (PLAN_LIMITS[planKey] ?? 0) : 0;

  const base: Omit<Entitlement, "canRead" | "reason"> = {
    planKey,
    planName,
    dailyLimit: planKey && dailyLimit === null ? null : planKey ? dailyLimit : 0,
    usedToday,
    extraCredits,
    freeUntil: freeUntil ? freeUntil.toISOString() : null,
  };

  if (planKey && dailyLimit === null) {
    return { ...base, canRead: true, reason: "ok" };
  }
  if (planKey && usedToday < (dailyLimit as number)) {
    return { ...base, canRead: true, reason: "ok" };
  }
  if (extraCredits > 0) {
    return { ...base, canRead: true, reason: "use_credit" };
  }
  return {
    ...base,
    canRead: false,
    reason: planKey ? "limit_reached" : "no_plan",
  };
}

/**
 * Admission check run BEFORE any expensive work.
 *
 * When the request is only allowed via a purchased extra credit, the credit is
 * RESERVED here with an atomic guarded decrement — two concurrent requests
 * holding one credit can never both be admitted. Callers must invoke
 * refundAllowance() if the reading subsequently fails, so a failed reading
 * never costs a paid credit.
 *
 * Returns the (possibly re-fetched) entitlement; check `canRead` for admission.
 */
export async function reserveAllowance(userId: string): Promise<Entitlement> {
  const ent = await getEntitlement(userId);
  if (!ent.canRead || ent.reason !== "use_credit") return ent;

  // Atomically consume one credit; the WHERE guard makes concurrent
  // reservations race safely — losers see no row updated.
  const updated = await db.execute(
    sql`UPDATE users SET extra_credits = extra_credits - 1 WHERE id = ${userId} AND extra_credits > 0 RETURNING extra_credits`,
  );
  if (updated.rows.length === 0) {
    // Someone else took the last credit between the check and the decrement.
    return await getEntitlement(userId);
  }
  return ent;
}

/**
 * Returns a reserved extra credit when the reading failed after admission.
 * Only applies to `use_credit` admissions; plan-based admissions cost nothing.
 */
export async function refundAllowance(
  userId: string,
  entBefore: Entitlement,
): Promise<void> {
  if (entBefore.reason === "use_credit") {
    await db.execute(
      sql`UPDATE users SET extra_credits = extra_credits + 1 WHERE id = ${userId}`,
    );
  }
}

type Executor = Pick<typeof db, "select" | "execute">;

/**
 * Atomically inserts a reading while consuming the allowance it costs.
 *
 * Runs inside a transaction holding a per-user advisory lock, so concurrent
 * requests for the same user are serialized here: the entitlement is
 * re-checked under the lock (closing the pre-check race on daily limits),
 * the reading row is inserted, and — when the reading is only possible via a
 * purchased extra credit — exactly one credit is decremented in the same
 * transaction (guarded so it can never go negative).
 *
 * Returns `{ row }` on success, or `{ blocked }` with the fresh entitlement
 * when the allowance was exhausted by a concurrent request.
 */
export async function insertReadingConsumingAllowance<
  TValues extends Record<string, unknown>,
>(
  userId: string,
  insertFn: (tx: DbTransaction) => Promise<TValues>,
): Promise<{ row: TValues; blocked?: never } | { row?: never; blocked: Entitlement }> {
  return db.transaction(async (tx) => {
    // Serialize all allowance consumption for this user in this transaction.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`,
    );
    const ent = await getEntitlement(userId, tx);
    if (!ent.canRead) {
      return { blocked: ent };
    }
    const row = await insertFn(tx);
    if (ent.reason === "use_credit") {
      const updated = await tx.execute(
        sql`UPDATE users SET extra_credits = extra_credits - 1 WHERE id = ${userId} AND extra_credits > 0 RETURNING extra_credits`,
      );
      if (updated.rows.length === 0) {
        // Should be impossible under the advisory lock; abort to be safe.
        throw new Error("Extra credit no longer available");
      }
    }
    return { row };
  });
}

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
