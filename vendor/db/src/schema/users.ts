import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

// id = Firebase UID
export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email"),
  scansRemaining: integer("scans_remaining").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type User = typeof usersTable.$inferSelect;
