import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

// id = Firebase UID
export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email"),
  scansRemaining: integer("scans_remaining").notNull().default(0),
  // The user's own details, used for their daily astro reading and to compare
  // them with the people they read ("you and them").
  birthDate: text("birth_date"),
  birthTime: text("birth_time"),
  birthPlace: text("birth_place"),
  // Short AI summaries of the user's own face and palm; the photos themselves
  // are never stored.
  selfFaceProfile: text("self_face_profile"),
  selfPalmProfile: text("self_palm_profile"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type User = typeof usersTable.$inferSelect;
