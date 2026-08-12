/**
 * QO'SHILISH MANBASINI ANIQLASH — sof funksiya (I/O yo'q, shuning uchun sinaladi).
 *
 * Telegram `chat_member` yangilanishi + darvoza sessiyasidan foydalanuvchi kanalga
 * QAYSI yo'l bilan kirganini aniqlaydi. Statistikadagi "Bot orqali qo'shilgan
 * yagona odamlar" raqami to'g'ridan-to'g'ri shu funksiyaga bog'liq.
 */

export type JoinSource = "bot" | "link" | "request" | "folder" | "direct";

export type JoinSourceInput = {
  /** `ChatMemberUpdated.invite_link` — faqat havola orqali kirilganda keladi */
  inviteLink?: { invite_link: string; creator?: { id: number } } | null;
  viaJoinRequest?: boolean;
  viaChatFolderInviteLink?: boolean;
  /** Bot o'zining user id'si (`ctx.me.id`) */
  botId: number;
  /** DB'da saqlangan tracking havolasi */
  storedBotLink: string | null;
  /** Darvoza sessiyasi: bloklab turgan kanal id'lari va ko'rsatilgan vaqt */
  gate?: { channels: string[]; at?: number } | null;
  /** Joriy kanal id (satr ko'rinishida — sessiyada shunday saqlanadi) */
  chatId: string;
  /** Darvoza "yangi" hisoblanadigan oyna */
  windowMs: number;
  now?: number;
};

export function resolveJoinSource(i: JoinSourceInput): JoinSource {
  // 1. Havola orqali kirgan bo'lsa — havola BOTNIKIMI?
  //
  // Asosiy belgi — `creator.id`. Bot qachondir yaratgan HAR QANDAY havola "bot"
  // bo'lib sanaladi. Bu muhim: kanal paneldan o'chirilib qayta qo'shilsa yangi
  // havola yaratiladi, eskisi esa kanalda tirik qoladi — faqat satr solishtirilsa
  // o'sha eski havola bilan kelganlar yo'qolardi. Bot API'da havolalar ro'yxatini
  // olish metodi yo'q, ya'ni eskilarini tiklashning boshqa yo'li ham yo'q.
  //
  // Satr solishtiruvi — zaxira (creator kutilmaganda bo'lmasa).
  //
  // Boshqa admin yaratgan havolada Telegram satrning ikkinchi qismini "…" bilan
  // niqoblaydi, shuning uchun qo'lda yaratilgan havola hech qachon satr bo'yicha
  // mos kelmaydi — creator tekshiruvisiz u "link" bo'lib qolardi.
  if (i.inviteLink) {
    const byCreator = i.inviteLink.creator?.id === i.botId;
    const byString = !!i.storedBotLink && i.inviteLink.invite_link === i.storedBotLink;
    return byCreator || byString ? "bot" : "link";
  }

  if (i.viaJoinRequest) return "request";
  if (i.viaChatFolderInviteLink) return "folder";

  // 2. Telegram manbani aytmadi (ochiq kanalga @username orqali kirilganda shunday
  //    bo'ladi). Darvozaga qaraymiz: shu odamga aynan shu kanal majburiy obuna
  //    sifatida ko'rsatilganmi va bu YAQINDA bo'lganmi.
  //
  //    Yangilik sharti majburiy: eskirgan sessiya organik qo'shilishni "bot" deb
  //    belgilab, sonni sun'iy oshirardi.
  const gate = i.gate;
  if (gate && Array.isArray(gate.channels) && gate.channels.includes(i.chatId)) {
    const now = i.now ?? Date.now();
    const fresh = typeof gate.at === "number" && now - gate.at <= i.windowMs;
    if (fresh) return "bot";
  }

  return "direct";
}
