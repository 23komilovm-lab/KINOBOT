import { prisma } from "../prisma.js";
import { e } from "./emoji.js";
import { formatUzDateTime } from "./dateRange.js";
import { ibtn, kb } from "./keyboard.js";
import type { Api } from "grammy";
import type { Payment } from "@prisma/client";

export const METHOD_LABEL: Record<string, string> = {
  karta: "💳 Karta orqali",
  ton: "💎 TON orqali o'tkazma",
  stars: "⭐ Telegram Stars",
};

/**
 * Foydalanuvchi ismi — profiliga o'tadigan ko'k havola sifatida.
 * Username bo'lsa t.me havolasi (har doim ishonchli), aks holda tg://user?id
 * (Telegram foydalanuvchini "biladigan" holatlarda ochiladi).
 */
export function userLink(
  id: bigint | number,
  firstName?: string | null,
  username?: string | null
): string {
  const name = e.escapeHtml(firstName?.trim() || "Foydalanuvchi");
  const url = username ? `https://t.me/${username.replace(/^@/, "")}` : `tg://user?id=${id}`;
  return `<a href="${url}">${name}</a>`;
}

const STATUS_LINE: Record<string, string> = {
  approved: "✅ <b>TASDIQLANDI</b> — premium yoqildi",
  rejected: "❌ <b>RAD ETILDI</b>",
};

/**
 * To'lov bildirishnomasi matni. Bir joyda turadi — chek kelganda ham,
 * tasdiqlangandan keyin yangilashda ham AYNAN shu matn ishlatiladi.
 */
export async function buildPaymentNotify(p: Payment): Promise<string> {
  const u = await prisma.user
    .findUnique({
      where: { id: p.userId },
      select: { firstName: true, username: true, createdAt: true, region: true },
    })
    .catch(() => null);

  const uname = u?.username ? `@${u.username}` : "—";
  const method = METHOD_LABEL[p.method] ?? p.method;

  const head =
    p.status === "pending"
      ? `<tg-emoji emoji-id="5258093637450866522">💎</tg-emoji> <b>Yangi premium to'lov!</b>`
      : `<tg-emoji emoji-id="5258093637450866522">💎</tg-emoji> <b>Premium to'lov</b>`;

  let reviewer = "";
  if (p.status !== "pending" && p.reviewedById) {
    const r = await prisma.user
      .findUnique({
        where: { id: p.reviewedById },
        select: { firstName: true, username: true },
      })
      .catch(() => null);
    reviewer = `\nKim ko'rib chiqdi: ${userLink(p.reviewedById, r?.firstName, r?.username)}`;
  }

  return (
    `${head}\n\n` +
    `To'lov ID: <code>#${p.id}</code>\n` +
    `Foydalanuvchi: <b>${userLink(p.userId, u?.firstName, u?.username)}</b> ${uname}\n` +
    `Telegram ID: <code>${p.userId}</code>\n` +
    (u?.region ? `Viloyat: <b>${e.escapeHtml(u.region)}</b>\n` : "") +
    (u?.createdAt ? `Botda ro'yxatdan o'tgan: <b>${formatUzDateTime(u.createdAt)}</b>\n` : "") +
    `Usul: <b>${method}</b>\n` +
    `Tarif: <b>${e.escapeHtml(p.tariffLabel)}</b> — ${p.amount.toLocaleString("ru-RU")} so'm (${p.days} kun)\n` +
    `To'lov vaqti: <b>${formatUzDateTime(p.createdAt)}</b>` +
    (p.status !== "pending"
      ? `\n\n${STATUS_LINE[p.status] ?? p.status}` +
        (p.reviewedAt ? ` · ${formatUzDateTime(p.reviewedAt)}` : "") +
        reviewer
      : "")
  );
}

/** Kutilayotgan to'lov uchun Tasdiqlash/Rad etish tugmalari */
export function pendingMarkup(paymentId: number) {
  return kb([
    ibtn("✅ Tasdiqlash", `prm:approve:${paymentId}`, "success"),
    ibtn("❌ Rad etish", `prm:reject:${paymentId}`, "danger"),
  ]);
}

interface NotifyRef {
  c: number;
  m: number;
}

function parseRefs(json: string | null): NotifyRef[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as NotifyRef[]) : [];
  } catch {
    return [];
  }
}

export function serializeRefs(refs: NotifyRef[]): string {
  return JSON.stringify(refs);
}

/**
 * To'lov ko'rib chiqilgandan keyin BARCHA bildirishnoma nusxalarini yangilaydi
 * (ownerlar DM'i + audit kanali): matnga yakuniy holat qo'shiladi, tugmalar
 * olib tashlanadi. Ilgari faqat admin bosgan xabar yangilanib, kanaldagi
 * nusxa "kutilmoqda" holatida tugmalari bilan qolib ketardi.
 */
export async function refreshPaymentNotifications(api: Api, p: Payment): Promise<void> {
  const refs = parseRefs(p.notifyRefs);
  if (refs.length === 0) return;
  const text = await buildPaymentNotify(p);

  for (const r of refs) {
    await api.editMessageText(r.c, r.m, text, { parse_mode: "HTML" }).catch(() => {
      // Xabar o'chirilgan yoki tahrirlab bo'lmaydi — hech bo'lmasa tugmalarni olamiz
      return api.editMessageReplyMarkup(r.c, r.m, { reply_markup: undefined }).catch(() => null);
    });
  }
}
