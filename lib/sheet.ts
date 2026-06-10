// lib/sheet.ts
// ดึง FAQ จาก Google Sheet (CSV public URL) แล้ว cache ไว้ใน memory 60 วัน

const CACHE_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 วัน (milliseconds)

interface FaqRow {
  category: string;
  question: string;
  answer: string;
  keywords: string;
}

interface SheetCache {
  data: FaqRow[];
  fetchedAt: number; // timestamp
}

// cache เก็บไว้ใน memory ของ server (ไม่หายเมื่อ request ใหม่มา เพราะ Next.js reuse module)
let cache: SheetCache | null = null;

/**
 * แปลง CSV text → array ของ FaqRow
 * รองรับ value ที่มี comma อยู่ใน double quotes
 */
function parseCsv(csvText: string): FaqRow[] {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return [];

  // บรรทัดแรก = หัวตาราง (ข้าม)
  const rows = lines.slice(1);

  return rows
    .map((line) => {
      const cols = splitCsvLine(line);
      return {
        category: (cols[0] ?? "").trim(),
        question: (cols[1] ?? "").trim(),
        answer: (cols[2] ?? "").trim(),
        keywords: (cols[3] ?? "").trim(),
      };
    })
    .filter((row) => row.question && row.answer); // กรอง row ที่ว่างออก
}

/**
 * split CSV line โดยรองรับ double quotes
 */
function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      // ถ้าเจอ "" ข้างใน quotes = escape
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

/**
 * แปลง FaqRow[] → string สำหรับใส่ใน prompt
 * format: Q: ... | A: ...
 */
export function faqToPromptString(faqs: FaqRow[]): string {
  return faqs
    .map(
      (f) =>
        `[${f.category}] Q: ${f.question} | A: ${f.answer}` +
        (f.keywords ? ` | keywords: ${f.keywords}` : "")
    )
    .join("\n");
}

/**
 * ดึง FAQ จาก Google Sheet
 * - ถ้า cache ยังไม่หมดอายุ → return cache
 * - ถ้า cache หมดอายุหรือยังไม่มี → fetch ใหม่
 * - ถ้า fetch ใหม่ล้มเหลว → return cache เก่า (ถ้ามี) หรือ throw
 */
export async function fetchFaq(): Promise<FaqRow[]> {
  const now = Date.now();

  // ใช้ cache ถ้ายังไม่หมดอายุ
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    console.log("[Sheet] Using cached FAQ:", cache.data.length, "rows");
    return cache.data;
  }

  const csvUrl = process.env.SHEET_CSV_URL;
  if (!csvUrl) {
    throw new Error("SHEET_CSV_URL is not set in environment variables");
  }

  try {
    console.log("[Sheet] Fetching FAQ from Google Sheet...");

    const response = await fetch(csvUrl, {
      // บอก Next.js ไม่ต้อง cache ที่ edge (เราจัดการ cache เอง)
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Sheet fetch failed: HTTP ${response.status}`);
    }

    const csvText = await response.text();
    const data = parseCsv(csvText);

    if (data.length === 0) {
      throw new Error("Sheet returned empty data");
    }

    // อัปเดต cache
    cache = { data, fetchedAt: now };
    console.log("[Sheet] FAQ loaded:", data.length, "rows");

    return data;
  } catch (err) {
    // fetch ใหม่ล้มเหลว → ใช้ cache เก่าแทน (ถ้ามี)
    if (cache) {
      console.warn("[Sheet] Fetch failed, using stale cache:", err);
      return cache.data;
    }

    // ไม่มี cache เลย → throw ให้ caller จัดการ
    throw err;
  }
}
