import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { db, readingsTable, usersTable } from "@workspace/db";
import {
  CreateFaceReadingBody,
  CreatePalmReadingBody,
  CreateVoiceReadingBody,
  CreateAstroReadingBody,
  CreateComboReadingBody,
  GetReadingParams,
  DeleteReadingParams,
  GetReadingResponse,
  ListReadingsResponse,
  GetReadingStatsResponse,
} from "@workspace/api-zod";
import { generateImageBuffer } from "@workspace/integrations-gemini-ai-server/image";
import {
  ensureCompatibleFormat,
  speechToText,
} from "@workspace/integrations-gemini-ai-server/audio";
import {
  analyzeFace,
  analyzePalm,
  analyzeConversation,
  analyzeAstrology,
  analyzeCombo,
  analyzeSelfDaily,
  type SelfContext,
} from "../lib/persona";

const router: IRouter = Router();

function serializeReading<T extends { createdAt: Date }>(row: T) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

// Atomic conditional decrement — the WHERE clause is checked by Postgres
// itself, not read-then-written in JS, so two concurrent reading requests
// can't both pass a stale "credits > 0" check and drive the count negative.
// Returns the updated user, or null if there were no credits to spend.
async function decrementScanCredit(userId: string) {
  const [user] = await db
    .update(usersTable)
    .set({ scansRemaining: sql`${usersTable.scansRemaining} - 1` })
    .where(sql`${usersTable.id} = ${userId} AND ${usersTable.scansRemaining} > 0`)
    .returning();
  return user ?? null;
}

// The signed-in user's own saved details, or null if they haven't saved any.
async function loadSelf(userId: string): Promise<SelfContext | null> {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) return null;
  const self: SelfContext = {
    birthDate: user.birthDate,
    birthTime: user.birthTime,
    birthPlace: user.birthPlace,
    faceProfile: user.selfFaceProfile,
    palmProfile: user.selfPalmProfile,
  };
  return self.birthDate || self.faceProfile || self.palmProfile ? self : null;
}

function isValidCalendarDate(dateStr: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return false;
  const d = new Date(`${dateStr}T00:00:00Z`);
  return (
    !isNaN(d.getTime()) &&
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() + 1 === Number(m[2]) &&
    d.getUTCDate() === Number(m[3])
  );
}

// All reading routes require a signed-in user; data is scoped per user.
router.use("/readings", requireAuth);

router.get("/readings", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(readingsTable)
    .where(eq(readingsTable.userId, req.userId!))
    .orderBy(desc(readingsTable.createdAt));
  res.json(ListReadingsResponse.parse(rows.map(serializeReading)));
});

router.get("/readings/stats", async (req, res): Promise<void> => {
  const rows = await db
    .select({
      kind: readingsTable.kind,
      count: sql<number>`count(*)::int`,
    })
    .from(readingsTable)
    .where(eq(readingsTable.userId, req.userId!))
    .groupBy(readingsTable.kind);
  const [latest] = await db
    .select({ archetype: readingsTable.archetype })
    .from(readingsTable)
    .where(eq(readingsTable.userId, req.userId!))
    .orderBy(desc(readingsTable.createdAt))
    .limit(1);
  const count = (k: string) => rows.find((r) => r.kind === k)?.count ?? 0;
  res.json(
    GetReadingStatsResponse.parse({
      total: rows.reduce((a, r) => a + r.count, 0),
      faceCount: count("face"),
      palmCount: count("palm"),
      voiceCount: count("voice"),
      astroCount: count("astro"),
      comboCount: count("combo"),
      latestArchetype: latest?.archetype ?? null,
    }),
  );
});

router.get("/readings/:id", async (req, res): Promise<void> => {
  const params = GetReadingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .select()
    .from(readingsTable)
    .where(
      and(
        eq(readingsTable.id, params.data.id),
        eq(readingsTable.userId, req.userId!),
      ),
    );
  if (!row) {
    res.status(404).json({ error: "Reading not found" });
    return;
  }
  res.json(GetReadingResponse.parse(serializeReading(row)));
});

router.delete("/readings/:id", async (req, res): Promise<void> => {
  const params = DeleteReadingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db
    .delete(readingsTable)
    .where(
      and(
        eq(readingsTable.id, params.data.id),
        eq(readingsTable.userId, req.userId!),
      ),
    )
    .returning();
  if (!row) {
    res.status(404).json({ error: "Reading not found" });
    return;
  }
  res.sendStatus(204);
});

router.post("/readings/face", async (req, res): Promise<void> => {
  const parsed = CreateFaceReadingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const debited = await decrementScanCredit(req.userId!);
  if (!debited) {
    res.status(402).json({ error: "out_of_credits", message: "You're out of reading credits. Buy more to continue." });
    return;
  }

  const mimeType = parsed.data.mimeType ?? "image/jpeg";
  const analysis = await analyzeFace(parsed.data.imageBase64, mimeType, parsed.data.language, await loadSelf(req.userId!));

  let portraitImage: string | null = null;
  if (analysis.portraitPrompt) {
    try {
      const buffer = await generateImageBuffer(
        `Artistic archetype portrait illustration, tarot-card style, no text: ${analysis.portraitPrompt}`,
        "1024x1024",
      );
      portraitImage = `data:image/png;base64,${buffer.toString("base64")}`;
    } catch (err) {
      req.log.warn({ err }, "Portrait generation failed, continuing without");
    }
  }

  const [row] = await db
    .insert(readingsTable)
    .values({
      userId: req.userId,
      kind: "face",
      archetype: analysis.archetype,
      title: analysis.title,
      summary: analysis.summary,
      traits: analysis.traits,
      strengths: analysis.strengths,
      guidance: analysis.guidance,
      interactionTips: analysis.interactionTips,
      details: analysis.details,
      compatibility: analysis.compatibility ?? null,
      judgment: analysis.judgment ?? null,
      portraitImage,
    })
    .returning();
  res.status(201).json(GetReadingResponse.parse(serializeReading(row)));
});

router.post("/readings/palm", async (req, res): Promise<void> => {
  const parsed = CreatePalmReadingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const debited = await decrementScanCredit(req.userId!);
  if (!debited) {
    res.status(402).json({ error: "out_of_credits", message: "You're out of reading credits. Buy more to continue." });
    return;
  }

  const mimeType = parsed.data.mimeType ?? "image/jpeg";
  const analysis = await analyzePalm(parsed.data.imageBase64, mimeType, parsed.data.language, await loadSelf(req.userId!));
  const [row] = await db
    .insert(readingsTable)
    .values({
      userId: req.userId,
      kind: "palm",
      archetype: analysis.archetype,
      title: analysis.title,
      summary: analysis.summary,
      traits: analysis.traits,
      strengths: analysis.strengths,
      guidance: analysis.guidance,
      interactionTips: analysis.interactionTips,
      details: analysis.details,
      compatibility: analysis.compatibility ?? null,
      judgment: analysis.judgment ?? null,
    })
    .returning();
  res.status(201).json(GetReadingResponse.parse(serializeReading(row)));
});

router.post("/readings/voice", async (req, res): Promise<void> => {
  const parsed = CreateVoiceReadingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const debited = await decrementScanCredit(req.userId!);
  if (!debited) {
    res.status(402).json({ error: "out_of_credits", message: "You're out of reading credits. Buy more to continue." });
    return;
  }

  const audioBuffer = Buffer.from(parsed.data.audioBase64, "base64");
  const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
  if (audioBuffer.length > MAX_UPLOAD_BYTES) {
    res.status(413).json({
      error:
        "That recording is too large to analyze (about 30 minutes max). Please record a shorter conversation and try again.",
    });
    return;
  }
  let buffer: Buffer;
  let format: "wav" | "mp3";
  try {
    ({ buffer, format } = await ensureCompatibleFormat(audioBuffer));
  } catch (err) {
    req.log.error({ err }, "Voice audio conversion failed");
    res.status(422).json({
      error:
        "We couldn't process that recording. It may be in an unsupported format — try a shorter or clearer one.",
    });
    return;
  }
  if (buffer.length > 25 * 1024 * 1024) {
    res.status(413).json({
      error:
        "That recording is too long to transcribe. Please record a shorter conversation and try again.",
    });
    return;
  }
  let transcript: string;
  try {
    transcript = await speechToText(buffer, format);
  } catch (err) {
    req.log.error({ err }, "Transcription failed");
    res.status(422).json({
      error:
        "We couldn't transcribe that recording. It may be too long or in an unsupported format — try a shorter recording.",
    });
    return;
  }
  if (!transcript || transcript.trim().length < 3) {
    res.status(400).json({
      error:
        "We couldn't hear anything in that recording. Please try again and speak clearly.",
    });
    return;
  }
  const analysis = await analyzeConversation(
    transcript,
    parsed.data.mode ?? "note",
    parsed.data.language,
    await loadSelf(req.userId!),
  );
  const [row] = await db
    .insert(readingsTable)
    .values({
      userId: req.userId,
      kind: "voice",
      archetype: analysis.archetype,
      title: analysis.title,
      summary: analysis.summary,
      traits: analysis.traits,
      strengths: analysis.strengths,
      guidance: analysis.guidance,
      interactionTips: analysis.interactionTips,
      details: analysis.details,
      compatibility: analysis.compatibility ?? null,
      judgment: analysis.judgment ?? null,
      transcript,
    })
    .returning();
  res.status(201).json(GetReadingResponse.parse(serializeReading(row)));
});

router.post("/readings/astro", async (req, res): Promise<void> => {
  const parsed = CreateAstroReadingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { birthDate, birthTime, birthPlace } = parsed.data;

  // No birth details in the request: the user's own personal daily reading,
  // from their saved profile. One per day — asking again the same day returns
  // today's reading without using another credit.
  if (!birthDate) {
    const self = await loadSelf(req.userId!);
    if (!self?.birthDate) {
      res.status(409).json({ error: "profile_required", message: "Add your birth details in your profile first." });
      return;
    }
    const today =
      parsed.data.today && isValidCalendarDate(parsed.data.today)
        ? parsed.data.today
        : new Date().toISOString().slice(0, 10);
    const existing = await db
      .select()
      .from(readingsTable)
      .where(
        and(
          eq(readingsTable.userId, req.userId!),
          eq(readingsTable.kind, "astro"),
          sql`${readingsTable.daily} IS NOT NULL`,
          sql`(${readingsTable.daily} ->> 'date') = ${today}`,
        ),
      )
      .orderBy(desc(readingsTable.createdAt))
      .limit(1);
    if (existing[0]) {
      res.status(200).json(GetReadingResponse.parse(serializeReading(existing[0])));
      return;
    }
    const debitedSelf = await decrementScanCredit(req.userId!);
    if (!debitedSelf) {
      res.status(402).json({ error: "out_of_credits", message: "You're out of reading credits. Buy more to continue." });
      return;
    }
    const daily = await analyzeSelfDaily(self, today, parsed.data.language);
    const [row] = await db
      .insert(readingsTable)
      .values({
        userId: req.userId,
        kind: "astro",
        archetype: daily.archetype,
        title: daily.title,
        summary: daily.summary,
        traits: daily.traits,
        strengths: daily.strengths,
        guidance: daily.guidance,
        interactionTips: daily.interactionTips,
        details: daily.details,
        zodiacSign: daily.zodiacSign,
        luckyColor: daily.luckyColor,
        luckyNumber: daily.luckyNumber,
        dailyHoroscope: daily.dailyHoroscope,
        daily: { ...daily.daily, date: today },
      })
      .returning();
    res.status(201).json(GetReadingResponse.parse(serializeReading(row)));
    return;
  }

  const debited = await decrementScanCredit(req.userId!);
  if (!debited) {
    res.status(402).json({ error: "out_of_credits", message: "You're out of reading credits. Buy more to continue." });
    return;
  }

  if (!isValidCalendarDate(birthDate)) {
    res.status(400).json({ error: "Please provide a valid birth date (YYYY-MM-DD)." });
    return;
  }
  // Normalize/validate optional birth time: accept "HH:MM" or "HH:MM:SS"
  let normalizedTime: string | undefined;
  if (birthTime && birthTime.trim() !== "") {
    const timeMatch = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(birthTime.trim());
    const hh = timeMatch ? Number(timeMatch[1]) : -1;
    const mm = timeMatch ? Number(timeMatch[2]) : -1;
    if (!timeMatch || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      res.status(400).json({
        error: "Please provide a valid birth time in HH:MM format (24-hour), or leave it empty.",
      });
      return;
    }
    normalizedTime = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  const todayIso = new Date().toISOString().slice(0, 10);
  const analysis = await analyzeAstrology(
    birthDate,
    normalizedTime,
    birthPlace ?? "unknown",
    todayIso,
    parsed.data.language,
  );
  const [row] = await db
    .insert(readingsTable)
    .values({
      userId: req.userId,
      kind: "astro",
      archetype: analysis.archetype,
      title: analysis.title,
      summary: analysis.summary,
      traits: analysis.traits,
      strengths: analysis.strengths,
      guidance: analysis.guidance,
      interactionTips: analysis.interactionTips,
      details: analysis.details,
      zodiacSign: analysis.zodiacSign,
      luckyColor: analysis.luckyColor,
      luckyNumber: analysis.luckyNumber,
      dailyHoroscope: analysis.dailyHoroscope,
    })
    .returning();
  res.status(201).json(GetReadingResponse.parse(serializeReading(row)));
});

router.post("/readings/combo", async (req, res): Promise<void> => {
  const parsed = CreateComboReadingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { context, imageBase64, mimeType, birthDate, birthTime, birthPlace, audioBase64 } = parsed.data;
  if (!imageBase64 && !birthDate && !audioBase64) {
    res.status(400).json({
      error: "Please provide at least one source: a face photo, birth details, or a recorded conversation.",
    });
    return;
  }
  if (birthDate && !isValidCalendarDate(birthDate)) {
    res.status(400).json({ error: "Please provide a valid birth date (YYYY-MM-DD)." });
    return;
  }

  const debited = await decrementScanCredit(req.userId!);
  if (!debited) {
    res.status(402).json({ error: "out_of_credits", message: "You're out of reading credits. Buy more to continue." });
    return;
  }

  let transcript: string | undefined;
  if (audioBase64) {
    const audioBuffer = Buffer.from(audioBase64, "base64");
    if (audioBuffer.length > 24 * 1024 * 1024) {
      res.status(413).json({
        error: "That recording is too large to analyze (about 30 minutes max). Please record a shorter conversation.",
      });
      return;
    }
    let converted: Awaited<ReturnType<typeof ensureCompatibleFormat>>;
    try {
      converted = await ensureCompatibleFormat(audioBuffer);
    } catch (err) {
      req.log.error({ err }, "Combo audio conversion failed");
      res.status(422).json({
        error: "We couldn't process that recording. Try again or continue without audio.",
      });
      return;
    }
    if (converted.buffer.length > 25 * 1024 * 1024) {
      res.status(413).json({
        error: "That recording is too long to transcribe. Please record a shorter conversation.",
      });
      return;
    }
    try {
      transcript = await speechToText(converted.buffer, converted.format);
    } catch (err) {
      req.log.error({ err }, "Combo transcription failed");
      res.status(422).json({
        error: "We couldn't transcribe that recording. Try a shorter recording or continue without audio.",
      });
      return;
    }
    if (!transcript || transcript.trim().length < 3) {
      transcript = undefined;
    }
  }

  // Re-check effective sources: audio that produced no transcript doesn't count
  if (!imageBase64 && !birthDate && !transcript) {
    res.status(400).json({
      error:
        "We couldn't hear anything in that recording. Please add a face photo, birth details, or a clearer recording.",
    });
    return;
  }

  const analysis = await analyzeCombo({
    context,
    imageBase64,
    mimeType,
    birthDate,
    birthTime,
    birthPlace,
    transcript,
    todayIso: new Date().toISOString().slice(0, 10),
    language: parsed.data.language,
    self: await loadSelf(req.userId!),
  });
  const [row] = await db
    .insert(readingsTable)
    .values({
      userId: req.userId,
      kind: "combo",
      archetype: analysis.archetype,
      title: analysis.title,
      summary: analysis.summary,
      traits: analysis.traits,
      strengths: analysis.strengths,
      guidance: analysis.guidance,
      interactionTips: analysis.interactionTips,
      details: analysis.details,
      compatibility: analysis.compatibility ?? null,
      judgment: analysis.judgment ?? null,
      transcript: transcript ?? null,
      zodiacSign: analysis.zodiacSign ?? null,
    })
    .returning();
  res.status(201).json(GetReadingResponse.parse(serializeReading(row)));
});

export default router;
