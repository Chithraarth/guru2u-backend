import { pgTable, text, serial, integer, timestamp, index } from "drizzle-orm/pg-core";

// Follow-up questions a user asks about one of their readings, with Guru's
// answer. Each question costs one reading credit.
export const readingQuestionsTable = pgTable(
  "reading_questions",
  {
    id: serial("id").primaryKey(),
    readingId: integer("reading_id").notNull(),
    userId: text("user_id").notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("reading_questions_reading_idx").on(table.readingId, table.userId)],
);

export type ReadingQuestion = typeof readingQuestionsTable.$inferSelect;
