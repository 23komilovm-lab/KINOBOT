import { prisma } from "../prisma.js";
import type { Bot } from "grammy";
import type { MyContext } from "../types.js";
import { log, notifyOwner } from "../utils/logger.js";

/**
 * Broadcast job — restart-safe holat DB'da saqlanadi.
 * Jarayon o'rtasida crash bo'lsa, yozuv "running" da qoladi va keyingi
 * boot'da reconcileBroadcastJobs uni "interrupted" qilib, owner'ga xabar beradi.
 */
export interface BroadcastJobData {
  targetType: string;
  targetExtra?: string | null;
  total: number;
  templateChatId?: bigint | null;
  templateMsgId?: number | null;
  buttonsJson?: string | null;
}

/** Yuborish BOSHIDAN oldin job yaratadi — crash bo'lsa ham yozuv saqlanadi. */
export async function createBroadcastJob(data: BroadcastJobData): Promise<number> {
  const job = await prisma.broadcast.create({
    data: {
      targetType: data.targetType,
      targetExtra: data.targetExtra ?? null,
      status: "running",
      total: data.total,
      processed: 0,
      templateChatId: data.templateChatId ?? null,
      templateMsgId: data.templateMsgId ?? null,
      buttonsJson: data.buttonsJson ?? null,
    },
    select: { id: true },
  });
  log("info", "Broadcast job yaratildi", { id: job.id, total: data.total });
  return job.id;
}

export interface BroadcastProgress {
  processed?: number;
  sentCount?: number;
  failCount?: number;
  blockedCount?: number;
  status?: string;
  abortReason?: string | null;
  // Qayta yuborish uchun shablon/xato ro'yxati — faqat yakuniy yozuvda o'rnatiladi
  templateChatId?: bigint | null;
  templateMsgId?: number | null;
  buttonsJson?: string | null;
  failedIds?: string | null;
}

/** Progressni DB'ga yozadi. Xato loglanadi, lekin broadcast to'xtatilmaydi. */
export async function updateBroadcastJob(id: number, p: BroadcastProgress): Promise<void> {
  const data: Record<string, unknown> = {};
  if (p.processed !== undefined) data.processed = p.processed;
  if (p.sentCount !== undefined) data.sentCount = p.sentCount;
  if (p.failCount !== undefined) data.failCount = p.failCount;
  if (p.blockedCount !== undefined) data.blockedCount = p.blockedCount;
  if (p.status !== undefined) data.status = p.status;
  if (p.abortReason !== undefined) data.abortReason = p.abortReason;
  if (p.templateChatId !== undefined) data.templateChatId = p.templateChatId;
  if (p.templateMsgId !== undefined) data.templateMsgId = p.templateMsgId;
  if (p.buttonsJson !== undefined) data.buttonsJson = p.buttonsJson;
  if (p.failedIds !== undefined) data.failedIds = p.failedIds;
  if (Object.keys(data).length === 0) return;

  await prisma.broadcast.update({ where: { id }, data }).catch((e) => {
    log("error", "Broadcast job yangilashda xato", { id, error: String(e) });
  });
}

export async function finalizeBroadcastJob(
  id: number,
  status: "completed" | "aborted",
  opts?: { abortReason?: string | null; failedIds?: string | null }
): Promise<void> {
  await updateBroadcastJob(id, {
    status,
    abortReason: opts?.abortReason ?? null,
    failedIds: opts?.failedIds ?? null,
  });
}

/**
 * Startup'da chaqiriladi: "running" holatdagi (crash'dan qolgan) job'lar
 * "interrupted" qilinadi va owner'ga retry taklifi yuboriladi.
 */
export async function reconcileBroadcastJobs(_bot?: Bot<MyContext>): Promise<void> {
  const stale = await prisma.broadcast.findMany({
    where: { status: "running" },
    orderBy: { id: "desc" },
    take: 5,
  });
  if (stale.length === 0) return;

  await prisma.broadcast.updateMany({
    where: { id: { in: stale.map((j) => j.id) } },
    data: { status: "interrupted" },
  });
  log("warn", "To'xtab qolgan broadcast job'lar interrupted qilindi", { count: stale.length });

  for (const job of stale) {
    // Har job uchun alohida throttle kaliti — aks holda notifyOwner 5 daqiqalik
    // key-throttle tufayli bir nechta interrupted job'dan faqat birinchisini yetkazadi.
    // Xabarda Retry tugmasi va'da qilinmaydi: interrupted job'da failedIds bo'lmaydi
    // (crash finalize'ga yetib bormagan), to'liq-resume esa hali qo'llanmagan —
    // halol matn: nima bo'lgani + qancha ishlangani + yangi broadcast taklifi.
    await notifyOwner(
      `⚠️ Broadcast #${job.id} qayta ishga tushirish paytida to'xtab qolgan edi.\n` +
        `Holat: interrupted · ${job.processed}/${job.total} ta foydalanuvchi ishlandi.\n` +
        `Yuborilmaganlarga avtomatik qayta yuborish (to'liq-resume) hali yo'q — ` +
        `kerak bo'lsa admin panelda yangi 📢 Broadcast boshlang.`,
      `broadcast-reconcile-${job.id}`
    );
  }
}
