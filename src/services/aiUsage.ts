import { prisma } from "../prisma.js";
import { setUsageSink, type ProviderId } from "./ai.js";
import { todayUz } from "../utils/dateRange.js";

function today(): string {
  return todayUz(); // "YYYY-MM-DD" — Toshkent vaqti (UTC+5)
}

/** askAI muvaffaqiyatli chaqiruvidan keyin sarfni kunlik jamlaydi */
async function record(provider: ProviderId, model: string, tokens: number) {
  const day = today();
  await prisma.aiUsage
    .upsert({
      where: { provider_model_day: { provider, model, day } },
      create: { provider, model, day, requests: 1, tokens },
      update: { requests: { increment: 1 }, tokens: { increment: tokens } },
    })
    .catch(() => null);
}

/** ai.ts usage sink'ini DB'ga ulaydi (index.ts startupda chaqiradi) */
export function initAiUsageTracking(): void {
  setUsageSink((provider, model, tokens) => {
    void record(provider, model, tokens);
  });
}

/** Bugungi sarf (provayder bo'yicha jamlangan) */
export async function todayUsage(): Promise<Record<string, { requests: number; tokens: number }>> {
  const rows = await prisma.aiUsage.findMany({ where: { day: today() } });
  const out: Record<string, { requests: number; tokens: number }> = {};
  for (const r of rows) {
    const key = r.provider;
    if (!out[key]) out[key] = { requests: 0, tokens: 0 };
    out[key].requests += r.requests;
    out[key].tokens += r.tokens;
  }
  return out;
}
