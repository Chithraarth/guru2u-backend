import { pgTable, text, serial, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export interface DailyExtras {
  luckyGemstone: string;
  luckyOutfit: string;
  luckyDay: string;
  dayOutlook: string;
  healthCare: string;
  temperCare: string;
  /** How love life looks today (older readings may not have it). */
  loveLife?: string;
  /** The user's local date this daily reading is for (YYYY-MM-DD). */
  date?: string;
}

/** 1-100% judgment of the person read. */
export interface Judgment {
  overall: number;
  verdict: "good" | "mixed" | "careful";
  verdictText: string;
  scores: {
    trust: number;
    honesty: number;
    kindness: number;
    communication: number;
    business: number;
    relationship: number;
  };
  business: string;
  relationship: string;
}

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
  // Personal daily reading extras (astro readings about the user themself).
  daily: jsonb("daily").$type<DailyExtras>(),
  // How things will go between the user and the person read.
  compatibility: text("compatibility"),
  // Good-or-bad judgment with 1-100% scores (readings of other people).
  judgment: jsonb("judgment").$type<Judgment>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertReadingSchema = createInsertSchema(readingsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertReading = z.infer<typeof insertReadingSchema>;
export type Reading = typeof readingsTable.$inferSelect;
