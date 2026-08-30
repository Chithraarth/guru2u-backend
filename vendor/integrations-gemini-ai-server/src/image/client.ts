import { Buffer } from "node:buffer";
import { gemini } from "../client";

const IMAGE_MODEL = "gemini-3.1-flash-image";

export async function generateImageBuffer(
  prompt: string,
  size: "1024x1024" | "512x512" | "256x256" = "1024x1024",
): Promise<Buffer> {
  const response = await gemini.models.generateContent({
    model: IMAGE_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseModalities: ["TEXT", "IMAGE"] },
  });
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((part) => part.inlineData?.data);
  const base64 = imagePart?.inlineData?.data ?? "";
  if (!base64) {
    throw new Error("Gemini did not return an image for the portrait prompt");
  }
  return Buffer.from(base64, "base64");
}
