import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { db, readingsTable } from "@workspace/db";
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
} from "../lib/persona";

const router: IRouter = Router();

function serializeReading<T extends { createdAt: Date }>(row: T) {
  return { ...row, createdAt: row.createdAt.toISOString() };
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
  const mimeType = parsed.data.mimeType ?? "image/jpeg";
  const analysis = await analyzeFace(parsed.data.imageBase64, mimeType, parsed.data.language);

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
  const mimeType = parsed.data.mimeType ?? "image/jpeg";
  const analysis = await analyzePalm(parsed.data.imageBase64, mimeType, parsed.data.language);
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
  const audioBuffer = Buffer.from(parsed.data.audioBase64, "base64");
  const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
  if (audioBuffer.length > MAX_UPLOAD_BYTES) {
    res.status(413).json({
      error:
        "That recording is too large to analyze (about 30 minutes max). Please record a shorter conversation and try again.",
    });
    return;
  }
  const { buffer, format } = await ensureCompatibleFormat(audioBuffer);
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
    birthPlace,
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
      transcript: transcript ?? null,
      zodiacSign: analysis.zodiacSign ?? null,
    })
    .returning();
  res.status(201).json(GetReadingResponse.parse(serializeReading(row)));
});

export default router;
