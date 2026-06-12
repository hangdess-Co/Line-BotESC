export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { fetchFaq, faqToPromptString } from "@/lib/sheet";
import { buildPrompt, DEFAULT_REPLY, NO_FAQ_REPLY } from "@/lib/prompt";
import { askGemini } from "@/lib/gemini";

const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply";

interface LineEvent {
  type: string;
  replyToken?: string;
  message?: { type: string; text?: string };
}

interface LineWebhookBody {
  events: LineEvent[];
}

async function replyToLine(replyToken: string, text: string): Promise<void> {
  const accessToken = process.env.CHANNEL_ACCESS_TOKEN;
  if (!accessToken) throw new Error("CHANNEL_ACCESS_TOKEN is not set");
  const response = await fetch(LINE_REPLY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LINE reply failed: ${response.status} - ${errText}`);
  }
}

async function handleMessage(replyToken: string, userMessage: string): Promise<void> {
  let replyText = DEFAULT_REPLY;
  try {
    let faqContent = "";
    try {
      const faqs = await fetchFaq();
      faqContent = faqToPromptString(faqs);
    } catch (err) {
      console.error("[Webhook] Failed to fetch FAQ:", err);
      await replyToLine(replyToken, NO_FAQ_REPLY);
      return;
    }
    const prompt = buildPrompt(faqContent, userMessage);
    replyText = await askGemini(prompt);
  } catch (err) {
    console.error("[Webhook] Unexpected error:", err);
    replyText = DEFAULT_REPLY;
  }
  try {
    await replyToLine(replyToken, replyText);
    console.log("[Webhook] Reply sent successfully");
  } catch (err) {
    console.error("[Webhook] Failed to reply to LINE:", err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();

  if (!rawBody || rawBody.includes('"events":[]')) {
    return NextResponse.json({ status: "ok" });
  }

  let body: LineWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Process all text message events and wait for completion
  const promises: Promise<void>[] = [];
  for (const event of body.events) {
    if (event.type !== "message" || event.message?.type !== "text") continue;
    const replyToken = event.replyToken;
    const userMessage = event.message?.text ?? "";
    if (!replyToken || !userMessage.trim()) continue;
    console.log("[Webhook] User message:", userMessage);
    promises.push(handleMessage(replyToken, userMessage));
  }

  // Wait for all messages to be handled
  await Promise.allSettled(promises);

  return NextResponse.json({ status: "ok" });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: "LINE webhook is running" });
}