import { GoogleGenAI } from "@google/genai";

if (!process.env.AI_INTEGRATIONS_GEMINI_API_KEY) {
  throw new Error(
    "AI_INTEGRATIONS_GEMINI_API_KEY environment variable is required. Did you forget to provision the Gemini AI integration?",
  );
}

export const gemini = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
});
