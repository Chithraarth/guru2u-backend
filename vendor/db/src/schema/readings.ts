import { pgTable, text, serial, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const readingsTable = pgTable("readings", {
  id: serial("id").primaryKey(),
  userId: text("user_id"),
  kind: text("kind").notNull(), // face | palm | voice
  archetype: text("archetype").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  traits: jsonb("traits").$type<string[]>().notNull().default([]),
  strengths: jsonb("strengths").$type<string[]>().notNull().default([]),
  guidance: text("guidance").notNull(),
  interactionTips: jsonb("interaction_tips").$type<string[]>().notNull().default([]),
  details: text("details"),
  transcript: text("transcript"),
  portraitImage: text("portrait_image"),
  zodiacSign: text("zodiac_sign"),
  luckyColor: text("lucky_color"),
  luckyNumber: text("lucky_number"),
  dailyHoroscope: text("daily_horoscope"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertReadingSchema = createInsertSchema(readingsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertReading = z.infer<typeof insertReadingSchema>;
export type Reading = typeof readingsTable.$inferSelect;
