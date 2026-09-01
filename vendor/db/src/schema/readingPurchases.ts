import { pgTable, text, serial, integer, timestamp, unique } from "drizzle-orm/pg-core";

export const readingPurchasesTable = pgTable(
  "reading_purchases",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    productId: text("product_id").notNull(),
    purchaseToken: text("purchase_token").notNull(),
    scansGranted: integer("scans_granted").notNull(),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [unique().on(table.purchaseToken)],
);

export type ReadingPurchase = typeof readingPurchasesTable.$inferSelect;
