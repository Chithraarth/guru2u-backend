import { Buffer } from "node:buffer";
export type AudioFormat = "wav" | "mp3" | "webm" | "mp4" | "ogg" | "unknown";
/**
 * Detect audio format from buffer magic bytes.
 * Supports: WAV, MP3, WebM (Chrome/Firefox), MP4/M4A/MOV (Safari/iOS), OGG
 */
export declare function detectAudioFormat(buffer: Buffer): AudioFormat;
/**
 * Convert any audio/video format to WAV using ffmpeg.
 */
export declare function convertToWav(audioBuffer: Buffer): Promise<Buffer>;
/**
 * Auto-detect and convert audio to a Gemini-compatible format.
 */
export declare function ensureCompatibleFormat(audioBuffer: Buffer): Promise<{
    buffer: Buffer;
    format: "wav" | "mp3";
}>;
/** Speech-to-text via Gemini's native multimodal audio understanding. */
export declare function speechToText(audioBuffer: Buffer, format?: "wav" | "mp3" | "webm"): Promise<string>;
//# sourceMappingURL=client.d.ts.map