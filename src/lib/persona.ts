import { Type, type Schema } from "@google/genai";
import { gemini } from "@workspace/integrations-gemini-ai-server";

const ANALYSIS_MODEL = "gemini-3.7-flash";

export interface PersonaAnalysis {
  archetype: string;
  title: string;
  summary: string;
  traits: string[];
  strengths: string[];
  guidance: string;
  interactionTips: string[];
  details: string;
  portraitPrompt?: string;
  compatibility?: string;
  judgment?: Judgment;
}

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

const SCORE_KEYS = ["trust", "honesty", "kindness", "communication", "business", "relationship"] as const;

function pct(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(1, Math.min(100, n)) : 50;
}

function parseJudgment(raw: unknown): Judgment | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const j = raw as Record<string, unknown>;
  const scores = (j.scores ?? {}) as Record<string, unknown>;
  if (!SCORE_KEYS.every((k) => scores[k] !== undefined)) return undefined;
  const overall = pct(j.overall);
  const verdict = j.verdict === "good" || j.verdict === "careful" || j.verdict === "mixed"
    ? j.verdict
    : overall >= 70 ? "good" : overall >= 45 ? "mixed" : "careful";
  return {
    overall,
    verdict,
    verdictText: typeof j.verdictText === "string" ? j.verdictText.trim() : "",
    scores: Object.fromEntries(SCORE_KEYS.map((k) => [k, pct(scores[k])])) as Judgment["scores"],
    business: typeof j.business === "string" ? j.business.trim() : "",
    relationship: typeof j.relationship === "string" ? j.relationship.trim() : "",
  };
}

const JUDGMENT_PROPERTY: Schema = {
  type: Type.OBJECT,
  description:
    "An honest judgment of the OTHER person with scores from 1 to 100. Base every score on the evidence; do not inflate. Use the full range: a person with clear red flags should score low.",
  properties: {
    overall: { type: Type.INTEGER, description: "1-100: how good and safe this person is to deal with overall" },
    verdict: {
      type: Type.STRING,
      enum: ["good", "mixed", "careful"],
      description: "good = a genuinely good person to deal with, mixed = some caution, careful = be careful with them",
    },
    verdictText: { type: Type.STRING, description: 'A short verdict, max 8 words, e.g. "A genuinely good person to work with"' },
    scores: {
      type: Type.OBJECT,
      properties: {
        trust: { type: Type.INTEGER, description: "1-100 how far the user can trust them" },
        honesty: { type: Type.INTEGER, description: "1-100 how honest and straightforward they are" },
        kindness: { type: Type.INTEGER, description: "1-100 how kind and good-hearted they are" },
        communication: { type: Type.INTEGER, description: "1-100 how well the user and they will communicate" },
        business: { type: Type.INTEGER, description: "1-100 how well a business or work relationship with them will go" },
        relationship: { type: Type.INTEGER, description: "1-100 how well a personal or romantic relationship with them will go" },
      },
      required: ["trust", "honesty", "kindness", "communication", "business", "relationship"],
    },
    business: { type: Type.STRING, description: "1-2 sentences: how a business or work relationship with them will go" },
    relationship: { type: Type.STRING, description: "1-2 sentences: how a personal or love relationship with them will go" },
  },
  required: ["overall", "verdict", "verdictText", "scores", "business", "relationship"],
};

/** The signed-in user's own saved details, used to compare them with others. */
export interface SelfContext {
  birthDate?: string | null;
  birthTime?: string | null;
  birthPlace?: string | null;
  faceProfile?: string | null;
  palmProfile?: string | null;
}

function hasSelf(self?: SelfContext | null): self is SelfContext {
  return !!self && !!(self.birthDate || self.faceProfile || self.palmProfile);
}

function selfContextText(self: SelfContext): string {
  const lines: string[] = [];
  if (self.birthDate) {
    lines.push(
      `Born ${self.birthDate}${self.birthTime ? ` at ${self.birthTime}` : ""}${self.birthPlace ? ` in ${self.birthPlace}` : ""}.`,
    );
  }
  if (self.faceProfile) lines.push(`Their own face reading: ${self.faceProfile}`);
  if (self.palmProfile) lines.push(`Their own palm reading: ${self.palmProfile}`);
  return lines.join("\n");
}

/**
 * Extra instructions when the user has saved their own profile: compare the
 * person being read with the user and fill "compatibility".
 */
function compatibilityInstruction(self?: SelfContext | null): string {
  if (!hasSelf(self)) return "";
  return `\n\nTHE USER'S OWN PROFILE (the person asking, "you"):\n${selfContextText(self)}\n\nCombine this with your reading of the other person. In "compatibility", write 3-5 sentences addressed to the user ("you" and "they") on how things will go between the two of them: where your natures match or clash, the likely friction points, and exactly how the user should handle this person given who the user is. Also let the user's own profile shape "guidance" and "interactionTips".`;
}

const BASE_ANALYSIS_PROPERTIES = {
  archetype: {
    type: Type.STRING,
    description:
      'A short persona label starting with "The", e.g. "The Strong Independent One", "The Talkative Charmer", "The Quiet Strategist"',
  },
  title: { type: Type.STRING, description: "One engaging headline sentence about this person" },
  summary: { type: Type.STRING, description: "3-4 sentences summarizing their personality" },
  traits: {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description: "4-6 short personality trait phrases",
  },
  strengths: {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description: "3-5 short strength phrases",
  },
  guidance: {
    type: Type.STRING,
    description: "2-3 sentences of forward-looking guidance about what they should focus on next",
  },
  interactionTips: {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description:
      "4-6 short, bold, actionable coaching tips telling the USER exactly how to handle their next interaction with this person — how to open, when to pause and let them answer, what to say back, what to avoid, and one smart move that will win their agreement or respect. Each tip must be a concrete instruction (start with a verb), specific to THIS person's character, not generic advice.",
  },
  details: { type: Type.STRING, description: "A longer, warm, specific analysis (2-3 paragraphs)" },
  compatibility: {
    type: Type.STRING,
    description:
      "Only when the user's own profile is given: 3-5 sentences on how things will go between the user and this person, and how the user should handle them. Otherwise leave empty.",
  },
  judgment: JUDGMENT_PROPERTY,
  portraitPrompt: {
    type: Type.STRING,
    description:
      "A short, respectful visual description for an artistic portrait illustration representing this archetype (style, mood, colors) — do NOT describe the actual person's identity, just an archetypal character",
  },
} satisfies Record<string, Schema>;

const PERSONA_ANALYSIS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: BASE_ANALYSIS_PROPERTIES,
  required: ["archetype", "title", "summary", "traits", "strengths", "guidance", "judgment"],
};

// Instructs the model to write all user-visible reading content in the
// visitor's chosen language. JSON keys stay in English; portraitPrompt stays
// in English because it feeds an image-generation model.
export function languageInstruction(language?: string): string {
  if (!language || language.split("-")[0].toLowerCase() === "en") return "";
  return `\n\nIMPORTANT: Write ALL user-facing text values ("archetype", "title", "summary", "traits", "strengths", "guidance", "interactionTips", "details", and any horoscope fields) in the language with BCP-47 code "${language}", fluently and naturally as a native speaker would. Keep the JSON keys in English exactly as specified, and keep "portraitPrompt" in English.`;
}

function parseAnalysis(raw: string): PersonaAnalysis {
  const parsed = JSON.parse(raw) as Partial<PersonaAnalysis>;
  if (
    !parsed.archetype ||
    !parsed.title ||
    !parsed.summary ||
    !Array.isArray(parsed.traits) ||
    !Array.isArray(parsed.strengths) ||
    !parsed.guidance
  ) {
    throw new Error("AI response missing required fields");
  }
  return {
    archetype: parsed.archetype,
    title: parsed.title,
    summary: parsed.summary,
    traits: parsed.traits,
    strengths: parsed.strengths,
    guidance: parsed.guidance,
    interactionTips: Array.isArray(parsed.interactionTips)
      ? parsed.interactionTips
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.replace(/\*\*/g, "").trim())
      : [],
    details: parsed.details ?? "",
    portraitPrompt: parsed.portraitPrompt,
    compatibility: typeof parsed.compatibility === "string" && parsed.compatibility.trim() ? parsed.compatibility.trim() : undefined,
    judgment: parseJudgment((parsed as { judgment?: unknown }).judgment),
  };
}

function textOf(response: Awaited<ReturnType<typeof gemini.models.generateContent>>): string {
  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response");
  return text;
}

async function analyzeImage(
  imageBase64: string,
  mimeType: string,
  systemPrompt: string,
  language?: string,
  self?: SelfContext | null,
): Promise<PersonaAnalysis> {
  const response = await gemini.models.generateContent({
    model: ANALYSIS_MODEL,
    contents: [
      {
        role: "user",
        parts: [{ inlineData: { mimeType, data: imageBase64 } }],
      },
    ],
    config: {
      systemInstruction: `${systemPrompt}${compatibilityInstruction(self)}${languageInstruction(language)}`,
      responseMimeType: "application/json",
      responseSchema: PERSONA_ANALYSIS_SCHEMA,
    },
  });
  return parseAnalysis(textOf(response));
}

export async function analyzeFace(
  imageBase64: string,
  mimeType: string,
  language?: string,
  self?: SelfContext | null,
): Promise<PersonaAnalysis> {
  return analyzeImage(
    imageBase64,
    mimeType,
    `You are a warm, insightful face-reading expert for an entertainment app. The photo shows a person the USER wants to understand and handle better (a counterpart — someone they will talk to, negotiate with, or meet). Study the facial features, expression, and overall vibe and infer a personality profile: is this a decent, kind person? Strong and independent? Very talkative and social? Very smart and analytical? Address the user about this other person ("they", not "you"), and make "guidance" and "interactionTips" practical coaching for how the user should deal with them. Be positive, specific, and playful — never insulting or judgmental about appearance.`,
    language,
    self,
  );
}

export async function analyzePalm(
  imageBase64: string,
  mimeType: string,
  language?: string,
  self?: SelfContext | null,
): Promise<PersonaAnalysis> {
  return analyzeImage(
    imageBase64,
    mimeType,
    `You are an experienced palm reader for an entertainment app. The palm belongs to a person the USER wants to understand and handle better. Look at the palm in the photo — heart line, head line, life line, fate line, mounts, hand shape — and produce a personality and future reading about that person. Reference the specific lines you observe, address the user about this other person ("they", not "you"), and make "guidance" and "interactionTips" practical coaching for how the user should deal with them. Be positive, mystical yet grounded, and specific.`,
    language,
    self,
  );
}

export interface AstroAnalysis extends PersonaAnalysis {
  zodiacSign: string;
  luckyColor: string;
  luckyNumber: string;
  dailyHoroscope: string;
}

const ASTRO_ANALYSIS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    ...BASE_ANALYSIS_PROPERTIES,
    zodiacSign: {
      type: Type.STRING,
      description:
        'Their sun sign, e.g. "Leo"; mention rising/moon hints inside "details" if derivable',
    },
    luckyColor: { type: Type.STRING, description: 'Today\'s favourite/lucky color for them, e.g. "Emerald Green"' },
    luckyNumber: { type: Type.STRING, description: 'Today\'s lucky number as a string, e.g. "7"' },
    dailyHoroscope: {
      type: Type.STRING,
      description: "2-4 sentences of today's horoscope specific to their sign and chart",
    },
  },
  required: [
    "archetype",
    "title",
    "summary",
    "traits",
    "strengths",
    "guidance",
    "zodiacSign",
    "luckyColor",
    "luckyNumber",
    "dailyHoroscope",
  ],
};

export async function analyzeAstrology(
  birthDate: string,
  birthTime: string | undefined,
  birthPlace: string,
  todayIso: string,
  language?: string,
): Promise<AstroAnalysis> {
  const response = await gemini.models.generateContent({
    model: ANALYSIS_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Birth date: ${birthDate}\nBirth time: ${birthTime ?? "unknown"}\nBirth place: ${birthPlace}`,
          },
        ],
      },
    ],
    config: {
      systemInstruction: `You are a skilled, warm astrologer for an entertainment app. The birth details belong to a person the USER wants to understand and handle better; describe that person to the user ("they", not "you") and make "guidance" and "interactionTips" practical coaching for how the user should deal with them. Given the person's birth date, birth time (if known), and birth place, produce a full astrology reading: determine their sun sign (and moon/rising sign hints if birth time and place allow), describe their personality through their chart, and give guidance. Also produce TODAY's daily astrology for them (today is ${todayIso}): a daily horoscope, today's favourite/lucky color, and today's lucky number. Be positive, specific, and mystical yet grounded.${languageInstruction(language)}`,
      responseMimeType: "application/json",
      responseSchema: ASTRO_ANALYSIS_SCHEMA,
    },
  });
  const raw = textOf(response);
  const base = parseAnalysis(raw);
  const extra = JSON.parse(raw) as Partial<AstroAnalysis>;
  if (!extra.zodiacSign || !extra.luckyColor || !extra.luckyNumber || !extra.dailyHoroscope) {
    throw new Error("AI response missing astrology fields");
  }
  return {
    ...base,
    zodiacSign: extra.zodiacSign,
    luckyColor: extra.luckyColor,
    luckyNumber: String(extra.luckyNumber),
    dailyHoroscope: extra.dailyHoroscope,
  };
}

export type ComboContext = "interview" | "business" | "relationship" | "general";

const COMBO_CONTEXT_FOCUS: Record<ComboContext, string> = {
  interview: `CONTEXT: JOB INTERVIEW. The user is interviewing (or being interviewed by) this person. Judge them as a candidate/professional: competence and intelligence, honesty and consistency between what their face/voice project and what they say, confidence vs. nervousness vs. overconfidence, work ethic signals, communication clarity, whether they genuinely want this role or are just going through motions, and culture fit. In "guidance", tell the user clearly: does this person look like a strong hire (or a good employer), what to probe further, and any caution flags.`,
  business: `CONTEXT: BUSINESS TALK. The user is evaluating this person as a business partner, client, or counterpart. Judge: trustworthiness and sincerity, negotiation style, ambition, reliability, whether their words match their presence, hidden agendas, and how much confidence to place in their promises. In "guidance", tell the user whether to move forward, what terms to be careful about, and what this person likely wants from the deal.`,
  relationship: `CONTEXT: RELATIONSHIP. The user is evaluating this person as a girlfriend/boyfriend/partner. Judge: emotional availability, sincerity of their interest, kindness, temperament, what they want from the relationship, green and red flags. In "guidance", give honest relationship advice.`,
  general: `CONTEXT: GENERAL. The user wants to understand this person better. Give a complete, honest character picture and practical guidance for dealing with them.`,
};

const COMBO_ANALYSIS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    ...BASE_ANALYSIS_PROPERTIES,
    zodiacSign: { type: Type.STRING, description: "Their sun sign derived from the birth date, if provided" },
  },
  required: ["archetype", "title", "summary", "traits", "strengths", "guidance", "judgment"],
};

export async function analyzeCombo(input: {
  context: ComboContext;
  imageBase64?: string;
  mimeType?: string;
  birthDate?: string;
  birthTime?: string;
  birthPlace?: string;
  transcript?: string;
  todayIso: string;
  language?: string;
  self?: SelfContext | null;
}): Promise<PersonaAnalysis & { zodiacSign?: string }> {
  const sources: string[] = [];
  if (input.imageBase64) sources.push("their face photo (read their features, expression, and vibe)");
  if (input.birthDate) sources.push("their birth details (read their astrological chart)");
  if (input.transcript) sources.push("a transcript of the actual conversation (read what they say and how)");

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  if (input.imageBase64) {
    parts.push({ inlineData: { mimeType: input.mimeType ?? "image/jpeg", data: input.imageBase64 } });
  }
  const textParts: string[] = [];
  if (input.birthDate) {
    textParts.push(
      `Birth details: date ${input.birthDate}, time ${input.birthTime ?? "unknown"}, place ${input.birthPlace ?? "unknown"}. Today is ${input.todayIso}.`,
    );
  }
  if (input.transcript) {
    textParts.push(`Transcript of the conversation:\n\n"${input.transcript}"`);
  }
  if (textParts.length === 0) textParts.push("Read this person from the photo.");
  parts.push({ text: textParts.join("\n\n") });

  const response = await gemini.models.generateContent({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts }],
    config: {
      systemInstruction: `You are an elite people-reader for an entertainment app, combining face reading, astrology, and conversation analysis into one unified judgment of a person. You have been given: ${sources.join("; ")}.\n\n${COMBO_CONTEXT_FOCUS[input.context]}\n\nCross-reference every source you have: where face, chart, and words agree, state conclusions confidently; where they conflict, point out the tension (e.g. "their words are confident but their expression is guarded"). In "details", write a deep 3-5 paragraph profile covering: what type of person they are (sincere/calculated, innocent/experienced, intellectual/instinctive, confident/insecure), their emotional state, their true motivations and what they want from the user, honesty and trust signals, and clear green/red flags — always with evidence from the sources. Be honest and specific rather than flattering; stay respectful, never cruel.${compatibilityInstruction(input.self)}${languageInstruction(input.language)}`,
      responseMimeType: "application/json",
      responseSchema: COMBO_ANALYSIS_SCHEMA,
    },
  });
  const raw = textOf(response);
  const base = parseAnalysis(raw);
  let zodiacSign: string | undefined;
  if (input.birthDate) {
    try {
      const extra = JSON.parse(raw) as { zodiacSign?: string };
      zodiacSign = extra.zodiacSign;
    } catch {
      // zodiac sign is best-effort in combo readings
    }
  }
  return { ...base, zodiacSign };
}

export async function analyzeConversation(
  transcript: string,
  mode: "note" | "conversation" | "date" = "note",
  language?: string,
  self?: SelfContext | null,
): Promise<PersonaAnalysis> {
  const PERSON_PROFILE_INSTRUCTIONS = `In the "details" field, write a thorough, in-depth profile of the person (3-5 paragraphs) that clearly covers ALL of the following:
1. WHAT TYPE OF PERSON THEY ARE — their core character: are they innocent and sincere, or calculated? Genuinely good-hearted? Intellectual and sharp, or more emotional and instinctive? Confident or insecure? Give a clear verdict with the evidence from their words.
2. THEIR EMOTIONAL STATE — are they calm, excited, anxious, desperate, needy, content, guarded? Point to the exact phrases or patterns that reveal it.
3. THEIR INTERESTS AND MOTIVATIONS — what topics light them up, what they care about, what drives them.
4. WHAT THEY WANT FROM YOU — their intent toward the listener: friendship, help, validation, attention, business, romance, or something else? Are they being straightforward about it or indirect?
5. HONESTY AND TRUSTWORTHINESS SIGNALS — consistency, exaggeration, deflection, openness. Note green flags and gentle caution flags.
6. INTELLIGENCE AND COMMUNICATION STYLE — vocabulary, reasoning, humor, how clearly they express ideas.
Be honest and specific rather than flattering — this is meant to help the user truly understand the person. Stay respectful and never cruel.`;
  const DATE_FEEDBACK_INSTRUCTIONS = `In the "details" field, write a thorough, honest date-debrief (3-5 paragraphs) that clearly covers ALL of the following about the OTHER person (the user's date):
1. THEIR MINDSET ON THE DATE — were they genuinely engaged, curious about the user, distracted, nervous, performative, or just being polite? Point to exact phrases and moments.
2. INTEREST LEVEL — how interested do they seem romantically? Did they ask questions back, remember details, suggest future plans, flirt, or keep things surface-level? Give a clear, honest verdict.
3. WHAT TYPE OF PERSON THEY ARE — sincere or calculated, kind, intellectual, funny, confident or insecure, emotionally available or guarded — with evidence.
4. WHAT THEY SEEM TO WANT — a serious relationship, something casual, validation, company, or unclear? Direct or indirect about it?
5. GREEN FLAGS AND RED FLAGS — respectful listening, consistency, warmth vs. self-centeredness, negging, evasiveness, pushiness. Be honest but fair.
6. COMPATIBILITY & CHEMISTRY — how well the two of them clicked: shared humor, balanced talking, matching energy.
In "guidance", give the user practical next-step advice: whether a second date looks promising, what to watch for, and one or two tips on their own conversation style from this date.
Set "archetype" to a label for the DATE (the other person), e.g. "The Genuinely Smitten One", "The Charming But Guarded One". Be honest and specific rather than flattering — the user needs real feedback. Stay respectful, never cruel.`;
  const systemPrompt =
    mode === "date"
      ? `You are a warm, sharp dating coach and people-reader for an entertainment app. You are given the transcript of a real date conversation between the user (the person who recorded it) and their date. Identify the two speakers from context. Your job is to debrief the user on their date: read the other person's mindset, interest level, character, and intentions, and coach the user on what to do next.\n\n${DATE_FEEDBACK_INSTRUCTIONS}`
      : mode === "conversation"
      ? `You are a perceptive conversation analyst and people-reader for an entertainment app. You are given the transcript of a full conversation that may include multiple speakers. Your job is to give the user a clear, detailed picture of the person they were talking to (and/or the primary speaker): what type of person they are, how they interact — do they listen or dominate, ask questions or tell stories, agree easily or push back, use humor, show empathy, lead or follow? Because you can observe real interaction, give a rich, complete picture.\n\n${PERSON_PROFILE_INSTRUCTIONS}`
      : `You are a perceptive conversation analyst and people-reader for an entertainment app. The recording is of a person the USER wants to understand and handle better. From how the person talks — word choice, energy, pace implied by phrasing, topics, confidence — build a clear, detailed picture of who this person is, and make "guidance" and "interactionTips" practical coaching for how the user should deal with them.\n\n${PERSON_PROFILE_INSTRUCTIONS}`;
  const response = await gemini.models.generateContent({
    model: ANALYSIS_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              mode === "date"
                ? `Here is the transcript of my date conversation. Please debrief me on my date:\n\n"${transcript}"`
                : mode === "conversation"
                ? `Here is the transcript of the recorded conversation:\n\n"${transcript}"`
                : `Here is the transcript of what the person said:\n\n"${transcript}"`,
          },
        ],
      },
    ],
    config: {
      systemInstruction: `${systemPrompt}${compatibilityInstruction(self)}${languageInstruction(language)}`,
      responseMimeType: "application/json",
      responseSchema: PERSONA_ANALYSIS_SCHEMA,
    },
  });
  return parseAnalysis(textOf(response));
}

// ---- The user's own profile ----

const SELF_SUMMARY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: "4-6 sentences describing this person's personality, temperament and tendencies as read from the photo",
    },
  },
  required: ["summary"],
};

/**
 * Reads the user's OWN face or palm once, when they save their profile.
 * Only this short text is kept; the photo is discarded.
 */
export async function summarizeSelf(
  kind: "face" | "palm",
  imageBase64: string,
  mimeType: string,
): Promise<string> {
  const what =
    kind === "face"
      ? "a face-reading expert. Study the facial features, expression and overall vibe"
      : "an experienced palm reader. Read the heart, head, life and fate lines, mounts and hand shape";
  const response = await gemini.models.generateContent({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: imageBase64 } }] }],
    config: {
      systemInstruction: `You are ${what} for an entertainment app. This is the app user's OWN ${kind}. Write a short, neutral personality summary in English that will be used later to compare them with other people: temperament, strengths, tendencies, and what usually triggers or calms them. Be specific and respectful; never comment on attractiveness.`,
      responseMimeType: "application/json",
      responseSchema: SELF_SUMMARY_SCHEMA,
    },
  });
  const parsed = JSON.parse(textOf(response)) as { summary?: string };
  if (!parsed.summary) throw new Error("AI response missing summary");
  return parsed.summary.trim();
}

export interface DailyAnalysis extends AstroAnalysis {
  daily: {
    luckyGemstone: string;
    luckyOutfit: string;
    luckyDay: string;
    dayOutlook: string;
    healthCare: string;
    temperCare: string;
    loveLife: string;
  };
}

const { judgment: _noJudgment, ...DAILY_BASE_PROPERTIES } = BASE_ANALYSIS_PROPERTIES;

const DAILY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    ...DAILY_BASE_PROPERTIES,
    zodiacSign: { type: Type.STRING, description: 'The user\'s sun sign, e.g. "Leo"' },
    luckyColor: { type: Type.STRING, description: 'Today\'s lucky color for the user, e.g. "Emerald Green"' },
    luckyNumber: { type: Type.STRING, description: 'Today\'s lucky number as a string, e.g. "7"' },
    dailyHoroscope: { type: Type.STRING, description: "2-4 sentences: the user's horoscope for today" },
    luckyGemstone: { type: Type.STRING, description: 'A lucky gemstone for the user, e.g. "Emerald (Panna)"' },
    luckyOutfit: {
      type: Type.STRING,
      description: 'What to wear today, e.g. "A light blue cotton shirt; avoid black"',
    },
    luckyDay: { type: Type.STRING, description: 'The user\'s luckiest day of this week, e.g. "Thursday"' },
    dayOutlook: { type: Type.STRING, description: "2-3 sentences on how today is likely to go: work, money, people" },
    healthCare: { type: Type.STRING, description: "1-2 sentences: what to take care of in their health today" },
    temperCare: {
      type: Type.STRING,
      description: "1-2 sentences: be careful about anger/aggression — when it may flare up today and how to keep calm",
    },
    loveLife: {
      type: Type.STRING,
      description: "2-3 sentences: how the user's love life looks today — for a couple, how to connect with their partner; if single, the chances of meeting someone and what to do",
    },
  },
  required: [
    "archetype", "title", "summary", "traits", "strengths", "guidance",
    "zodiacSign", "luckyColor", "luckyNumber", "dailyHoroscope",
    "luckyGemstone", "luckyOutfit", "luckyDay", "dayOutlook", "healthCare", "temperCare", "loveLife",
  ],
};

/** The user's own personal daily reading, from their saved details. */
export async function analyzeSelfDaily(
  self: SelfContext,
  todayIso: string,
  language?: string,
): Promise<DailyAnalysis> {
  const response = await gemini.models.generateContent({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: `My details:\n${selfContextText(self)}\nToday is ${todayIso}.` }] }],
    config: {
      systemInstruction: `You are a warm, practical astrologer for an entertainment app. This is the USER'S OWN daily reading: address them directly as "you". Use their birth date, time and place (and their own face and palm readings when given) to work out their sun sign and chart, and give their reading for today (${todayIso}): today's horoscope, lucky color, lucky number, lucky gemstone, what to wear today, their luckiest day this week, how today will go, how their love life looks today, what to take care of in their health, and a clear warning about anger or aggression and how to stay calm. "archetype" is a label for the user's character today, "summary" describes their personality, "guidance" is advice for today, and "interactionTips" are 3-5 tips for handling people today. Be specific, positive and grounded.${languageInstruction(language)}`,
      responseMimeType: "application/json",
      responseSchema: DAILY_SCHEMA,
    },
  });
  const raw = textOf(response);
  const base = parseAnalysis(raw);
  const x = JSON.parse(raw) as Record<string, unknown>;
  const str = (k: string) => (typeof x[k] === "string" ? (x[k] as string).trim() : String(x[k] ?? "")).trim();
  for (const k of ["zodiacSign", "luckyColor", "dailyHoroscope", "luckyGemstone", "luckyOutfit", "luckyDay", "dayOutlook", "healthCare", "temperCare", "loveLife"]) {
    if (!str(k)) throw new Error(`AI response missing ${k}`);
  }
  return {
    ...base,
    judgment: undefined,
    zodiacSign: str("zodiacSign"),
    luckyColor: str("luckyColor"),
    luckyNumber: str("luckyNumber"),
    dailyHoroscope: str("dailyHoroscope"),
    daily: {
      luckyGemstone: str("luckyGemstone"),
      luckyOutfit: str("luckyOutfit"),
      luckyDay: str("luckyDay"),
      dayOutlook: str("dayOutlook"),
      healthCare: str("healthCare"),
      temperCare: str("temperCare"),
      loveLife: str("loveLife"),
    },
  };
}
