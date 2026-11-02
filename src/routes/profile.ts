import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, readingQuestionsTable, readingsTable, usersTable, type User } from "@workspace/db";
import { firebaseAuth } from "../lib/firebase-admin";
import { requireAuth } from "../middlewares/requireAuth";
import { summarizeSelf } from "../lib/persona";

// The signed-in user's own details: birth date/time/place plus short
// summaries of their own face and palm. Used for their personal daily astro
// reading and to compare them with the people they read.
const router: IRouter = Router();

router.use("/me", requireAuth);

function toProfile(user: User | undefined) {
  return {
    birthDate: user?.birthDate ?? null,
    birthTime: user?.birthTime ?? null,
    birthPlace: user?.birthPlace ?? null,
    hasFace: !!user?.selfFaceProfile,
    hasPalm: !!user?.selfPalmProfile,
  };
}

function isValidCalendarDate(dateStr: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return false;
  const d = new Date(`${dateStr}T00:00:00Z`);
  return (
    !isNaN(d.getTime()) &&
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() + 1 === Number(m[2]) &&
    d.getUTCDate() === Number(m[3]) &&
    d.getTime() <= Date.now()
  );
}

router.get("/me/profile", async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!));
  res.json(toProfile(user));
});

const ProfileBody = z.object({
  birthDate: z.string(),
  birthTime: z.string().nullish(),
  birthPlace: z.string().trim().min(1).max(120),
});

router.put("/me/profile", async (req, res): Promise<void> => {
  const parsed = ProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please enter your birth date and birth place." });
    return;
  }
  const { birthDate, birthPlace } = parsed.data;
  if (!isValidCalendarDate(birthDate)) {
    res.status(400).json({ error: "Please enter a valid birth date." });
    return;
  }
  let birthTime: string | null = null;
  const rawTime = parsed.data.birthTime?.trim();
  if (rawTime) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(rawTime);
    const hh = m ? Number(m[1]) : -1;
    const mm = m ? Number(m[2]) : -1;
    if (!m || hh > 23 || mm > 59) {
      res.status(400).json({ error: "Please enter a valid birth time." });
      return;
    }
    birthTime = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  const [user] = await db
    .update(usersTable)
    .set({ birthDate, birthTime, birthPlace })
    .where(eq(usersTable.id, req.userId!))
    .returning();
  res.json(toProfile(user));
});

const PhotoBody = z.object({
  imageBase64: z.string().min(1),
  mimeType: z.string().optional(),
});

// Reads the user's own face or palm once and keeps only the text summary.
// Free: it's part of setting up the profile, not a reading.
for (const kind of ["face", "palm"] as const) {
  router.post(`/me/profile/${kind}`, async (req, res): Promise<void> => {
    const parsed = PhotoBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Please choose a photo." });
      return;
    }
    let summary: string;
    try {
      summary = await summarizeSelf(kind, parsed.data.imageBase64, parsed.data.mimeType ?? "image/jpeg");
    } catch (err) {
      req.log.error({ err }, `Self ${kind} reading failed`);
      res.status(422).json({ error: "We couldn't read that photo. Please try a clearer one." });
      return;
    }
    const [user] = await db
      .update(usersTable)
      .set(kind === "face" ? { selfFaceProfile: summary } : { selfPalmProfile: summary })
      .where(eq(usersTable.id, req.userId!))
      .returning();
    res.json(toProfile(user));
  });
}

// Deletes the signed-in user's account: their readings, follow-up questions,
// profile and Firebase sign-in. Purchase records are kept (anonymous store
// transaction IDs) because they are needed for refunds and tax records.
router.delete("/me/account", async (req, res): Promise<void> => {
  const userId = req.userId!;
  await db.transaction(async (tx) => {
    await tx.delete(readingQuestionsTable).where(eq(readingQuestionsTable.userId, userId));
    await tx.delete(readingsTable).where(eq(readingsTable.userId, userId));
    await tx.delete(usersTable).where(eq(usersTable.id, userId));
  });
  try {
    await firebaseAuth.deleteUser(userId);
  } catch (err) {
    // Already gone in Firebase is fine; anything else the user can retry.
    if ((err as { code?: string }).code !== "auth/user-not-found") {
      req.log.error({ err }, "Firebase user deletion failed");
      res.status(500).json({ error: "We couldn't finish deleting your account. Please try again." });
      return;
    }
  }
  res.status(204).end();
});

export default router;
