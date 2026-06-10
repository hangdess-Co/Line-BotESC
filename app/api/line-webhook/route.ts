// app/api/line-webhook/route.ts
// LINE Webhook endpoint หลัก

import { NextRequest, NextResponse } from "next/server";
import * as crypto from "crypto";
import { fetchFaq, faqToPromptString } from "@/lib/sheet";
import { buildPrompt, DEFAULT_REPLY, NO_FAQ_REPLY } from "@/lib/prompt";
import { callGemini } from "@/lib/gemini";

// LINE API
const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply";

// ---- Types ----

interface LineEvent {
  type: string;
  replyToken?: string;
  message?: {
    type: string;
    text?: string;
  };
}

interface LineWebhookBody {
  events: LineEvent[];
}

// ---- Signature Verification ----

/**
 * ตรวจสอบ signature ที่ LINE ส่งมา
 * ป้องกัน request ปลอมจากคนอื่น
 */
function verifySignature(body: string, signature: string): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) {
    console.error("[Webhook] LINE_CHANNEL_SECRET is not set");
    return false;
  }

  const hmac = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64");

  return hmac === signature;
}

// ---- Reply to LINE ----

/**
 * ส่ง reply กลับไปหาลูกค้าผ่าน LINE Reply API
 */
async function replyToLine(replyToken: string, text: string): Promise<void> {
  const accessToken = process.env.CHANNEL_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("CHANNEL_ACCESS_TOKEN is not set in environment variables");
  }

  const response = await fetch(LINE_REPLY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LINE reply failed: HTTP ${response.status} - ${errText}`);
  }
}

// ---- Main Handler ----

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. อ่าน raw body สำหรับ verify signature
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";

  // 2. Verify signature
  if (!verifySignature(rawBody, signature)) {
    console.warn("[Webhook] Invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // 3. Parse body
  let body: LineWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.error("[Webhook] Failed to parse body");
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // 4. วน loop events (ปกติมีแค่ 1 event ต่อ request)
  for (const event of body.events) {
    // รับเฉพาะ message event ที่เป็น text
    if (event.type !== "message" || event.message?.type !== "text") {
      continue;
    }

    const replyToken = event.replyToken;
    const userMessage = event.message?.text ?? "";

    if (!replyToken || !userMessage.trim()) {
      continue;
    }

    console.log("[Webhook] User message:", userMessage);

    // 5. ดึง FAQ (async แต่ไม่ block response 200 ล่วงหน้า)
    //    ทำทุกอย่างใน background แล้วส่ง reply ให้ทัน 10 วิ
    handleMessage(replyToken, userMessage).catch((err) => {
      console.error("[Webhook] handleMessage error:", err);
    });
  }

  // 6. ตอบ LINE ว่ารับ event แล้ว (ต้องตอบเร็วๆ ไม่งั้น LINE retry)
  return NextResponse.json({ status: "ok" });
}

/**
 * จัดการ message event แบบ async
 * - fetch FAQ
 * - สร้าง prompt
 * - เรียก Gemini
 * - reply LINE
 */
async function handleMessage(
  replyToken: string,
  userMessage: string
): Promise<void> {
  let replyText = DEFAULT_REPLY;

  try {
    // 5a. ดึง FAQ
    let faqContent = "";
    try {
      const faqs = await fetchFaq();
      faqContent = faqToPromptString(faqs);
    } catch (err) {
      console.error("[Webhook] Failed to fetch FAQ:", err);
      // ถ้าดึง FAQ ไม่ได้เลย → ใช้ NO_FAQ_REPLY
      await replyToLine(replyToken, NO_FAQ_REPLY);
      return;
    }

    // 5b. สร้าง prompt
    const prompt = buildPrompt(faqContent, userMessage);

    // 5c. เรียก Gemini (จัดการ timeout + error ภายใน callGemini)
    replyText = await callGemini(prompt);
  } catch (err) {
    console.error("[Webhook] Unexpected error:", err);
    replyText = DEFAULT_REPLY;
  }

  // 5d. ส่ง reply กลับ LINE
  try {
    await replyToLine(replyToken, replyText);
    console.log("[Webhook] Reply sent successfully");
  } catch (err) {
    // log แต่ไม่ crash server
    console.error("[Webhook] Failed to reply to LINE:", err);
  }
}

// LINE ส่ง GET request ตอน verify webhook URL
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: "LINE webhook is running" });
}
