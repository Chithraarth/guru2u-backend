import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

// id = Firebase UID
export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  extraCredits: integer("extra_credits").notNull().default(0),
  freeUntil: timestamp("free_until"),
  shareRewardClaimedAt: timestamp("share_reward_claimed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type User = typeof usersTable.$inferSelect;
