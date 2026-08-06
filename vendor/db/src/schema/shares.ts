import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";

// One row per user + platform shared (honor-system share tracking)
export const shareEventsTable = pgTable(
  "share_events",
  {
    userId: text("user_id").notNull(),
    platform: text("platform").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.platform] })],
);
