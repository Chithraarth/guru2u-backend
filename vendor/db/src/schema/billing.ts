import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

// Idempotency ledger for one-off purchases (extra reading credits)
export const billingGrantsTable = pgTable("billing_grants", {
  sessionId: text("session_id").primaryKey(),
  userId: text("user_id").notNull(),
  credits: integer("credits").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
