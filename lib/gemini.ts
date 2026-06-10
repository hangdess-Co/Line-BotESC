// lib/gemini.ts
// เรียก Gemini API และ log สิ่งที่จำเป็นทุก request

import { DEFAULT_REPLY } from "./prompt";

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_TIMEOUT_MS = 8000; // 8 วิ (เผื่อเวลาส่งกลับ LINE ภายใน 10 วิ)

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

/**
 * เรียก Gemini แล้วคืน text reply
 * - timeout 8 วิ
 * - log finishReason, thoughtsTokenCount, candidatesTokenCount
 * - ถ้า finishReason === "MAX_TOKENS" → return DEFAULT_REPLY
 */
export async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set in environment variables");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 1.0,
      maxOutputTokens: 1024,
    },
  };

  // สร้าง AbortController สำหรับ timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error: HTTP ${response.status} - ${errText}`);
    }

    const data: GeminiResponse = await response.json();

    // ดึงค่าสำหรับ log
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason ?? "UNKNOWN";
    const candidatesTokenCount = data.usageMetadata?.candidatesTokenCount ?? 0;
    const thoughtsTokenCount = data.usageMetadata?.thoughtsTokenCount ?? 0;

    // log ทุก request
    console.log("[Gemini] finishReason:", finishReason);
    console.log("[Gemini] candidatesTokenCount:", candidatesTokenCount);
    console.log("[Gemini] thoughtsTokenCount:", thoughtsTokenCount);

    // ถ้าตอบมาไม่ครบ → ใช้ default reply แทน
    if (finishReason === "MAX_TOKENS") {
      console.warn("[Gemini] MAX_TOKENS reached → using DEFAULT_REPLY");
      return DEFAULT_REPLY;
    }

    // ดึง text จาก response
    const text = candidate?.content?.parts?.[0]?.text ?? "";

    if (!text.trim()) {
      console.warn("[Gemini] Empty response → using DEFAULT_REPLY");
      return DEFAULT_REPLY;
    }

    return text.trim();
  } catch (err: unknown) {
    clearTimeout(timeoutId);

    // timeout
    if (err instanceof Error && err.name === "AbortError") {
      console.error("[Gemini] Request timeout after", GEMINI_TIMEOUT_MS, "ms");
      return DEFAULT_REPLY;
    }

    // error อื่นๆ
    console.error("[Gemini] Error:", err);
    return DEFAULT_REPLY;
  }
}
