import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const MODEL_NAME = "gemini-2.5-flash";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("503") ||
    message.includes("UNAVAILABLE") ||
    message.includes("high demand") ||
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED")
  );
}

export async function askGemini(prompt: string): Promise<string> {
  const model = genAI.getGenerativeModel({ model: MODEL_NAME });
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text().trim();
    } catch (err) {
      lastError = err;
      if (isRetryableError(err) && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt;
        console.warn(`[Gemini] Attempt ${attempt} failed — retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      console.error(`[Gemini] Attempt ${attempt} failed:`, err);
      break;
    }
  }

  throw lastError;
}