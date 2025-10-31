// app/api/trips/[tripCode]/plan/route.ts
import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

/** ===== Next runtime & caching ===== */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** ===== Types ===== */
type Params = { params: Promise<{ tripCode: string }> };

type PlanItemType = "travel" | "meal" | "attraction" | "checkin" | "checkout" | "shopping";

interface PlanItem {
  time: string;
  name: string;
  type: PlanItemType;
  location?: string;
  estCost?: number;
  duration?: string;
}

interface PlanDay {
  day: string;
  label: string;
  items: PlanItem[];
}

interface Plan {
  title: string;
  dates: string | null;
  participants: number | null;
  totalBudget: number | null;
  overview: {
    destinations: string[];
    accommodation?: string;
    transportation?: string;
    totalDistance?: string;
  };
  itinerary: PlanDay[];
  budgetBreakdown: {
    transportation: number;
    accommodation: number;
    attractions: number;
    meals: number;
    shopping: number;
    miscellaneous: number;
  };
  tips: string[];
}

interface VoteSummary {
  name: string;
  location?: string;
  estimated_cost?: number;
  duration?: string;
}

interface SnapshotPayload {
  constraints?: {
    group_size?: number;
    max_budget_per_person?: number;
    travel_styles?: string[];
    preferred_provinces?: string[];
    date_window?: { all_dates?: string[] };
  };
  votes_summary?: VoteSummary[];
}

/** ===== CORS ===== */
const corsHeaders = {
  "Access-Control-Allow-Origin": process.env.CORS_ORIGIN ?? "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new Response(null, { headers: corsHeaders });
}

/** ===== System Prompt ===== */
const SYSTEM_INSTRUCTION = `
You are a professional Thai travel planner AI. You must respond ONLY with valid JSON matching this exact TypeScript type:

type Plan = {
  title: string;
  dates: string | null;
  participants: number | null;
  totalBudget: number | null;
  overview: { 
    destinations: string[];
    accommodation?: string;
    transportation?: string;
    totalDistance?: string;
  };
  itinerary: {
    day: string;
    label: string;
    items: {
      time: string;
      name: string;
      type: "travel" | "meal" | "attraction" | "checkin" | "checkout" | "shopping";
      location?: string;
      estCost?: number;
      duration?: string;
    }[]
  }[];
  budgetBreakdown: {
    transportation: number;
    accommodation: number;
    attractions: number;
    meals: number;
    shopping: number;
    miscellaneous: number;
  };
  tips: string[];
};

Rules:
- Return ONLY the JSON object, no markdown, no explanation
- All text in Thai language
- Create realistic, detailed itinerary based on the snapshot data
- Prioritize top-voted places in the itinerary
- Budget should match constraints (max budget per person × group size)
`.trim();

/** ===== Helpers: parsing params ===== */
function parseCSVList(v?: string | null): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * votes รองรับ 2 รูปแบบ:
 * 1) JSON ใน query (ต้อง URL-encode) เช่น:
 *    votes=[{"name":"ที่เที่ยว A","estimated_cost":200,"duration":"2 ชั่วโมง"}]
 * 2) แบบกึ่ง CSV:
 *    votes=a|200|2ชั่วโมง|เชียงใหม่;b|150|1.5ชม|ลำปาง
 *    (รูปแบบ: name|cost|duration|location ; คั่นรายการด้วย ;)
 */
function parseVotes(raw?: string | null): VoteSummary[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // ลอง JSON ก่อน
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .map(x => ({
          name: String(x.name ?? "").trim(),
          location: x.location ? String(x.location) : undefined,
          estimated_cost: typeof x.estimated_cost === "number" ? x.estimated_cost : x.estimated_cost ? Number(x.estimated_cost) : undefined,
          duration: x.duration ? String(x.duration) : undefined,
        }))
        .filter(x => x.name);
    }
  } catch {
    // ไม่เป็น JSON → ไป parse โหมดกึ่ง CSV ด้านล่าง
  }

  // โหมดกึ่ง CSV: a|200|2ชั่วโมง|เชียงใหม่;b|150|1.5ชม|ลำปาง
  const entries = trimmed.split(";").map(s => s.trim()).filter(Boolean);
  const votes: VoteSummary[] = [];
  for (const e of entries) {
    const [name, costStr, duration, location] = e.split("|").map(s => (s ?? "").trim());
    if (!name) continue;
    const cost = costStr ? Number(costStr) : undefined;
    votes.push({
      name,
      estimated_cost: isNaN(cost as number) ? undefined : (cost as number),
      duration: duration || undefined,
      location: location || undefined,
    });
  }
  return votes;
}

/** ประกอบ payload จาก query params หรือ body JSON */
async function buildPayloadFromRequest(req: Request): Promise<SnapshotPayload> {
  const url = new URL(req.url);
  const q = url.searchParams;

  // 1) อ่านจาก query params (priority ต่ำกว่า body)
  const groupQ = q.get("group");
  const budgetQ = q.get("budget");
  const datesQ = q.get("dates"); // คั่นด้วย comma
  const provincesQ = q.get("provinces"); // คั่นด้วย comma
  const stylesQ = q.get("styles"); // คั่นด้วย comma
  const votesQ = q.get("votes"); // JSON หรือ กึ่ง CSV

  // 2) ถ้ามี body JSON → override ได้
  let body: any = null;
  try {
    if (req.method !== "GET") {
      body = await req.json();
    }
  } catch {
    // ไม่มี body ก็ข้าม
  }

  const group_size =
    body?.group_size ??
    (groupQ ? Number(groupQ) : undefined);

  const max_budget_per_person =
    body?.max_budget_per_person ??
    (budgetQ ? Number(budgetQ) : undefined);

  const all_dates: string[] =
    body?.dates ??
    parseCSVList(datesQ);

  const preferred_provinces: string[] =
    body?.preferred_provinces ??
    parseCSVList(provincesQ);

  const travel_styles: string[] =
    body?.travel_styles ??
    parseCSVList(stylesQ);

  const votes_summary: VoteSummary[] =
    body?.votes_summary ??
    parseVotes(votesQ);

  const payload: SnapshotPayload = {
    constraints: {
      group_size,
      max_budget_per_person,
      travel_styles,
      preferred_provinces,
      date_window: { all_dates },
    },
    votes_summary,
  };

  return payload;
}

/** ===== Mock Logic (fallback เมื่อไม่มี GEMINI_API_KEY) ===== */
function mockPlanFromSnapshot(payload: SnapshotPayload): Plan {
  const group = payload?.constraints?.group_size ?? 2;
  const maxBudget = payload?.constraints?.max_budget_per_person ?? 10000;
  const dates = payload?.constraints?.date_window?.all_dates ?? [];
  const topPlaces = (payload?.votes_summary ?? []).slice(0, 3);
  const topNames = topPlaces.map((v) => v.name || "สถานที่ท่องเที่ยว");
  const totalBudget = group * maxBudget;

  const day1: PlanDay = {
    day: dates[0] || "2025-11-01",
    label: "วันที่ 1",
    items: [
      {
        time: "09:00",
        name: topNames[0] || "สถานที่ท่องเที่ยว A",
        type: "attraction",
        location: topPlaces[0]?.location || "ไม่ระบุ",
        estCost: Math.round((topPlaces[0]?.estimated_cost ?? 200) * group),
        duration: topPlaces[0]?.duration || "2 ชั่วโมง",
      },
      {
        time: "12:00",
        name: "อาหารกลางวัน - ร้านอาหารท้องถิ่น",
        type: "meal",
        estCost: 150 * group,
        duration: "1 ชั่วโมง",
      },
      {
        time: "14:00",
        name: topNames[1] || "สถานที่ท่องเที่ยว B",
        type: "attraction",
        location: topPlaces[1]?.location || "ไม่ระบุ",
        estCost: Math.round((topPlaces[1]?.estimated_cost ?? 150) * group),
        duration: topPlaces[1]?.duration || "2 ชั่วโมง",
      },
      {
        time: "18:00",
        name: "เช็คอินที่พัก",
        type: "checkin",
        estCost: 0,
        duration: "30 นาที",
      },
      {
        time: "19:00",
        name: "อาหารเย็น - ร้านอาหารริมน้ำ",
        type: "meal",
        estCost: 200 * group,
        duration: "1.5 ชั่วโมง",
      },
    ],
  };

  const day2: PlanDay = {
    day: dates[1] || "2025-11-02",
    label: "วันที่ 2",
    items: [
      {
        time: "08:00",
        name: "อาหารเช้าที่โรงแรม",
        type: "meal",
        estCost: 0,
        duration: "1 ชั่วโมง",
      },
      {
        time: "10:00",
        name: "เช็คเอาท์",
        type: "checkout",
        estCost: 0,
        duration: "30 นาที",
      },
      {
        time: "11:00",
        name: topNames[2] || "สถานที่ท่องเที่ยว C",
        type: "attraction",
        location: topPlaces[2]?.location || "ไม่ระบุ",
        estCost: Math.round((topPlaces[2]?.estimated_cost ?? 100) * group),
        duration: topPlaces[2]?.duration || "2 ชั่วโมง",
      },
      {
        time: "14:00",
        name: "เดินทางกลับ",
        type: "travel",
        estCost: 0,
        duration: "3 ชั่วโมง",
      },
    ],
  };

  return {
    title: `แผนการเดินทาง ${topNames[0] || "ท่องเที่ยวไทย"}`,
    dates: dates.length >= 2 ? `${dates[0]} ถึง ${dates[dates.length - 1]}` : null,
    participants: group,
    totalBudget,
    overview: {
      destinations: topNames,
      accommodation: "โรงแรม/รีสอร์ทใกล้จุดท่องเที่ยว",
      transportation: "รถเช่า / รถตู้",
      totalDistance: "≈ 150 กม.",
    },
    itinerary: [day1, day2],
    budgetBreakdown: {
      transportation: Math.round(totalBudget * 0.25),
      accommodation: Math.round(totalBudget * 0.30),
      attractions: Math.round(totalBudget * 0.20),
      meals: Math.round(totalBudget * 0.15),
      shopping: Math.round(totalBudget * 0.05),
      miscellaneous: Math.round(totalBudget * 0.05),
    },
    tips: [
      "เตรียมเงินสดสำหรับจ่ายค่าบริการเล็กน้อย",
      "ควรเผื่อเวลาเดินทางระหว่างจุดหมายประมาณ 20-30%",
      "ตรวจสอบสภาพอากาศก่อนออกเดินทาง",
      `งบประมาณรวม ${totalBudget.toLocaleString()} บาท สำหรับ ${group} คน`,
    ],
  };
}

/** ===== GET: ใช้ params สร้างแผน (ไม่มี DB) ===== */
export async function GET(req: Request, ctx: Params) {
  try {
    // tripCode ไม่ได้ใช้แล้ว แต่ยังคง path param ไว้เพื่อความเข้ากันได้
    await ctx.params;

    const payload = await buildPayloadFromRequest(req);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const mockPlan = mockPlanFromSnapshot(payload);
      return NextResponse.json(
        { success: true, data: mockPlan, fromLLM: false, note: "No GEMINI_API_KEY. Returned mock plan." },
        { headers: corsHeaders }
      );
    }

    // เรียก LLM
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp",
      systemInstruction: SYSTEM_INSTRUCTION,
    });

    const userPrompt = `
สร้างแผนการท่องเที่ยวแบบละเอียดจากข้อมูล snapshot ต่อไปนี้:

ข้อมูลกลุ่ม:
- จำนวนคน: ${payload?.constraints?.group_size ?? "ไม่ระบุ"} คน
- งบประมาณต่อคน (ขั้นต่ำ): ${payload?.constraints?.max_budget_per_person ?? "ไม่ระบุ"} บาท
- สไตล์การเที่ยว: ${JSON.stringify(payload?.constraints?.travel_styles ?? [])}
- จังหวัดที่นิยม: ${JSON.stringify(payload?.constraints?.preferred_provinces ?? [])}
- ช่วงวันที่เป็นไปได้: ${JSON.stringify(payload?.constraints?.date_window?.all_dates ?? [])}

สถานที่ที่ได้คะแนนโหวตสูงสุด (จัดตามลำดับ):
${JSON.stringify(payload?.votes_summary ?? [], null, 2)}

ข้อกำหนด:
1. สร้างแผนที่สมเหตุสมผลตามข้อมูลที่ให้มา
2. ใช้สถานที่ที่ได้คะแนนโหวตสูงเป็นหลัก
3. ระบุเวลา ระยะเวลา และค่าใช้จ่ายโดยประมาณ
4. งบประมาณรวมต้องไม่เกิน ${payload?.constraints?.max_budget_per_person ?? 10000} × ${payload?.constraints?.group_size ?? 2} บาท
5. กิจกรรมต้องเรียงลำดับที่สมเหตุสมผล
6. ตอบกลับเป็น JSON object เท่านั้น ห้ามมีข้อความอธิบายเพิ่มเติม
`.trim();

    const result = await model.generateContent(userPrompt);
    const text = result.response.text().trim();

    let planJson: Plan;
    try {
      let cleaned = text.includes("```")
        ? text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
        : text;
      planJson = JSON.parse(cleaned) as Plan;
    } catch {
      const mockPlan = mockPlanFromSnapshot(payload);
      return NextResponse.json(
        { success: true, data: mockPlan, fromLLM: false, note: "LLM JSON parse failed. Returned mock plan." },
        { headers: corsHeaders }
      );
    }

    return NextResponse.json(
      { success: true, data: planJson, fromLLM: true },
      { headers: corsHeaders }
    );
  } catch (err) {
    console.error("GET error:", err);
    return NextResponse.json(
      { success: false, error: (err as Error)?.message || "Unexpected error" },
      { status: 500, headers: corsHeaders }
    );
  }
}

/** ===== POST: body JSON ก็ได้ (ไม่มี DB) ===== */
export async function POST(req: Request, ctx: Params) {
  try {
    await ctx.params;
    const payload = await buildPayloadFromRequest(req);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const mockPlan = mockPlanFromSnapshot(payload);
      return NextResponse.json(
        { success: true, data: mockPlan, fromLLM: false, note: "No GEMINI_API_KEY. Returned mock plan." },
        { headers: corsHeaders }
      );
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp",
      systemInstruction: SYSTEM_INSTRUCTION,
    });

    const userPrompt = `
สร้างแผนการท่องเที่ยวแบบละเอียดจากข้อมูล snapshot ต่อไปนี้:

ข้อมูลกลุ่ม:
- จำนวนคน: ${payload?.constraints?.group_size ?? "ไม่ระบุ"} คน
- งบประมาณต่อคน (ขั้นต่ำ): ${payload?.constraints?.max_budget_per_person ?? "ไม่ระบุ"} บาท
- สไตล์การเที่ยว: ${JSON.stringify(payload?.constraints?.travel_styles ?? [])}
- จังหวัดที่นิยม: ${JSON.stringify(payload?.constraints?.preferred_provinces ?? [])}
- ช่วงวันที่เป็นไปได้: ${JSON.stringify(payload?.constraints?.date_window?.all_dates ?? [])}

สถานที่ที่ได้คะแนนโหวตสูงสุด (จัดตามลำดับ):
${JSON.stringify(payload?.votes_summary ?? [], null, 2)}

ข้อกำหนด:
1. สร้างแผนที่สมเหตุสมผลตามข้อมูลที่ให้มา
2. ใช้สถานที่ที่ได้คะแนนโหวตสูงเป็นหลัก
3. ระบุเวลา ระยะเวลา และค่าใช้จ่ายโดยประมาณ
4. งบประมาณรวมต้องไม่เกิน ${payload?.constraints?.max_budget_per_person ?? 10000} × ${payload?.constraints?.group_size ?? 2} บาท
5. กิจกรรมต้องเรียงลำดับที่สมเหตุสมผล
6. ตอบกลับเป็น JSON object เท่านั้น ห้ามมีข้อความอธิบายเพิ่มเติม
`.trim();

    const result = await model.generateContent(userPrompt);
    const text = result.response.text().trim();

    let planJson: Plan;
    try {
      let cleaned = text.includes("```")
        ? text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
        : text;
      planJson = JSON.parse(cleaned) as Plan;
    } catch {
      const mockPlan = mockPlanFromSnapshot(payload);
      return NextResponse.json(
        { success: true, data: mockPlan, fromLLM: false, note: "LLM JSON parse failed. Returned mock plan." },
        { headers: corsHeaders }
      );
    }

    return NextResponse.json(
      { success: true, data: planJson, fromLLM: true },
      { headers: corsHeaders }
    );
  } catch (err) {
    console.error("POST error:", err);
    return NextResponse.json(
      { success: false, error: (err as Error)?.message || "Unexpected error" },
      { status: 500, headers: corsHeaders }
    );
  }
}
