import { Composer } from "grammy";
import { prisma } from "../prisma.js";
import { ce, e } from "../utils/emoji.js";
import { ibtn, kb, userMenuKeyboard, aiActiveKeyboard } from "../utils/keyboard.js";
import { checkContentAccessResult, checkAiAccess, countAiRequest } from "../utils/access.js";
import { normalizeTitle } from "../utils/translit.js";
import { escapeLike } from "../services/search.js";
import {
  aiEnabled,
  askAIChat,
  askVision,
  visionEnabled,
  lastFailureWasRateLimited,
  type ChatMsg,
} from "../services/ai.js";
import { config } from "../config.js";
import { deliverMovie, deliverSerialSeasons } from "../services/delivery.js";
import { isPremiumActive } from "../utils/premium.js";
import type { DeliverResult } from "../services/delivery.js";
import type { MyContext } from "../types.js";
import { rememberPendingAction } from "../utils/pendingAction.js";

export const aiUserHandler = new Composer<MyContext>();

export const AI_BTN = "AI yordamchi";

// Bot ma'lumotlari
const ADMIN_CONTACT = "@akajon_00";
const CHANNEL = "@kinovaqti_00";

const PAGE_SIZE = 5;

interface AiListItem {
  type: "m" | "s";
  code: number;
  title: string;
}

const AI_EXIT = "❌ Chiqish";

// ─── Suhbat xotirasi (session) — oxirgi 6 xabar (3 juft), token uchun cheklangan ─
const HISTORY_MAX = 6;
function getHistory(ctx: MyContext): ChatMsg[] {
  const h = ctx.session.scratch?.aiHistory;
  return Array.isArray(h) ? (h as ChatMsg[]) : [];
}
function pushHistory(ctx: MyContext, userText: string, assistantText: string) {
  const h = getHistory(ctx);
  h.push({ role: "user", content: userText });
  h.push({ role: "assistant", content: assistantText });
  const trimmed = h.slice(-HISTORY_MAX);
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), aiHistory: trimmed };
}
function clearHistory(ctx: MyContext) {
  if (ctx.session.scratch) delete ctx.session.scratch.aiHistory;
}

type MovieCtx = {
  code: number;
  title: string;
  genre: string | null;
  year: number | null;
  views: number;
  quality: string | null;
  language: string | null;
  duration: number | null;
  isPremium: boolean;
  caption: string | null;
};
type SerialCtx = {
  code: number;
  title: string;
  genre: string | null;
  year: number | null;
  isPremium: boolean;
  caption: string | null;
};

/** Kontekst uchun bitta kinoni to'liq, lekin ixcham qatorga aylantiradi */
function movieLine(m: MovieCtx): string {
  const bits = [
    m.genre,
    m.year ? String(m.year) : null,
    m.quality,
    m.language,
    m.duration ? `${Math.round(m.duration / 60)} daq` : null,
    `${m.views}👁`,
  ].filter(Boolean);
  const desc = m.caption?.trim().replace(/\s+/g, " ").slice(0, 160);
  return (
    `- ${m.title} (kod: m${m.code}) [${bits.join(", ")}]` +
    (m.isPremium ? " 💎PREMIUM" : "") +
    (desc ? `\n    ${desc}` : "")
  );
}

function serialLine(s: SerialCtx): string {
  const bits = [s.genre, s.year ? String(s.year) : null].filter(Boolean);
  const desc = s.caption?.trim().replace(/\s+/g, " ").slice(0, 160);
  return (
    `- ${s.title} (kod: s${s.code}) [${bits.join(", ")}] [serial]` +
    (s.isPremium ? " 💎PREMIUM" : "") +
    (desc ? `\n    ${desc}` : "")
  );
}

const KEYWORD_EXTRACT_SYSTEM =
  `Foydalanuvchi "Kino vaqti" botiga yozgan xabardan JANR yoki KAYFIYAT/MAVZU kalit so'zlarini ajrat. ` +
  `Javobda FAQAT vergul bilan ajratilgan 1-5 ta o'zbekcha so'z/ibora bo'lsin ` +
  `(masalan: jangari, komediya, romantik, kosmos, urush, do'stlik, retro). ` +
  `Aniq janr/mavzu/kayfiyat bo'lmasa (salomlashish, umumiy savol, aniq film nomi) — bo'sh qator qaytar. ` +
  `Izoh, tirnoq, boshqa matn YOZMA.`;

/**
 * So'rovdan janr/kayfiyat kalit so'zlarini ajratadi (masalan "kosmosda qoladigan
 * kino" → "kosmos, fantastika"). Muvaffaqiyatsiz bo'lsa bo'sh massiv qaytaradi —
 * buildContext bunday holda oddiy so'zma-so'z qidiruv + mashhurlar bilan davom etadi.
 */
async function extractSearchKeywords(query: string): Promise<string[]> {
  const raw = await askAIChat("user", {
    system: KEYWORD_EXTRACT_SYSTEM,
    userText: query,
    maxTokens: 60,
  });
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 2 && s.length <= 30 && !/[[\]{}]/.test(s))
    .slice(0, 5);
}

/**
 * Foydalanuvchi so'roviga mos + mashhur kinolar/seriallardan QISQA kontekst
 * tuzadi (butun katalog emas — Groq kunlik token limiti tez tugamasligi uchun).
 *
 * Ikki bosqichli qidiruv: (1) so'zma-so'z (title/genre contains) — aniq nom
 * so'ralganda ishlaydi; (2) AI ajratgan janr/kayfiyat kalit so'zlari bo'yicha
 * KENGROQ so'rov — "kulgili narsa", "kosmos haqida" kabi so'zma-so'z mos
 * kelmaydigan so'rovlarda ham tegishli janrdagi kontentni topadi.
 */
async function buildContext(query: string): Promise<string> {
  const kw = query.trim();
  const rawWhere =
    kw.length >= 2
      ? {
          OR: [
            // titleNorm — kirill/lotin transkripsiyasi bir xil natija beradi
            { titleNorm: { contains: normalizeTitle(kw), mode: "insensitive" as const } },
            // genre `contains` LIKE ishlatadi — foydalanuvchi kiritgan %/_ wildcard
            // sifatida o'tib ketmasligi uchun escapeLike qilinadi
            { genre: { contains: escapeLike(kw), mode: "insensitive" as const } },
          ],
        }
      : undefined;

  const keywords = kw.length >= 2 ? await extractSearchKeywords(kw) : [];
  const genreWhere = keywords.length
    ? {
        OR: keywords.map((k) => ({
          genre: { contains: escapeLike(k), mode: "insensitive" as const },
        })),
      }
    : undefined;

  // So'rovda kod bo'lsa ("m12", "s7" yoki shunchaki "12") — aynan o'sha kontentni
  // kontekstga majburan qo'shamiz, aks holda mashhurlar ro'yxatiga tushmasa AI
  // "bunday kod yo'q" deb javob berardi.
  const codeWhere = (() => {
    const codes = [...kw.matchAll(/\b[ms]?(\d{1,7})\b/gi)].map((m) => Number(m[1])).slice(0, 5);
    return codes.length ? { code: { in: codes } } : undefined;
  })();

  const movieSelect = {
    code: true,
    title: true,
    genre: true,
    year: true,
    views: true,
    quality: true,
    language: true,
    duration: true,
    isPremium: true,
    caption: true,
  } as const;
  const serialSelect = {
    code: true,
    title: true,
    genre: true,
    year: true,
    isPremium: true,
    caption: true,
  } as const;

  const [
    codeMovies,
    rawMovies,
    genreMovies,
    popularMovies,
    codeSerials,
    rawSerials,
    genreSerials,
    popularSerials,
  ] = await Promise.all([
    codeWhere
      ? prisma.movie.findMany({ where: codeWhere, take: 5, select: movieSelect })
      : Promise.resolve([] as MovieCtx[]),
    rawWhere
      ? prisma.movie.findMany({
          where: rawWhere,
          take: 12,
          orderBy: { views: "desc" },
          select: movieSelect,
        })
      : Promise.resolve([] as MovieCtx[]),
    genreWhere
      ? prisma.movie.findMany({
          where: genreWhere,
          take: 12,
          orderBy: { views: "desc" },
          select: movieSelect,
        })
      : Promise.resolve([] as MovieCtx[]),
    prisma.movie.findMany({ orderBy: { views: "desc" }, take: 15, select: movieSelect }),
    codeWhere
      ? prisma.serial.findMany({ where: codeWhere, take: 5, select: serialSelect })
      : Promise.resolve([] as SerialCtx[]),
    rawWhere
      ? prisma.serial.findMany({
          where: rawWhere,
          take: 10,
          orderBy: { views: "desc" },
          select: serialSelect,
        })
      : Promise.resolve([] as SerialCtx[]),
    genreWhere
      ? prisma.serial.findMany({
          where: genreWhere,
          take: 10,
          orderBy: { views: "desc" },
          select: serialSelect,
        })
      : Promise.resolve([] as SerialCtx[]),
    prisma.serial.findMany({ orderBy: { views: "desc" }, take: 10, select: serialSelect }),
  ]);

  // Tartib MUHIM: kod bo'yicha topilganlar birinchi — pastdagi slice() ularni kesib tashlamasin
  const movieMap = new Map<number, MovieCtx>();
  for (const m of [...codeMovies, ...rawMovies, ...genreMovies, ...popularMovies])
    movieMap.set(m.code, m);
  const serialMap = new Map<number, SerialCtx>();
  for (const s of [...codeSerials, ...rawSerials, ...genreSerials, ...popularSerials])
    serialMap.set(s.code, s);

  // Token byudjetini nazorat qilamiz — jamlangan ro'yxat cheksiz o'smasin
  const movies = [...movieMap.values()].slice(0, 25);
  const serials = [...serialMap.values()].slice(0, 15);

  const mv = movies.length ? movies.map(movieLine).join("\n") : "yo'q";
  const sr = serials.length ? serials.map(serialLine).join("\n") : "yo'q";

  return (
    `KINOLAR:\n${mv}\n\nSERIALLAR:\n${sr}\n\n` +
    `(Bu — so'rovga mos + eng mashhur kontent. Qavs ichida: janr, yil, sifat, til, ` +
    `davomiylik, ko'rishlar. Pastdagi qator — qisqa tavsif. 💎PREMIUM belgisi bo'lsa ` +
    `bu kino faqat premium obunachilar uchun. Ro'yxatda yo'q narsani "bor" dema.)`
  );
}

/** Foydalanuvchi haqida AI uchun qisqa profil matni (premium holati bilan) */
async function buildUserInfo(ctx: MyContext): Promise<string> {
  const u = ctx.from!;
  const name = u.first_name?.trim() || "Foydalanuvchi";
  const lastName = u.last_name?.trim();
  const fullName = lastName ? `${name} ${lastName}` : name;
  const username = u.username ? `@${u.username}` : "yo'q";

  // Premium holati — AI 💎PREMIUM kinolarni yuborish yoki obuna taklif qilishni shunga qarab hal qiladi
  const dbUser = await prisma.user
    .findUnique({
      where: { id: BigInt(u.id) },
      select: { premiumUntil: true },
    })
    .catch(() => null);
  const premium = isPremiumActive(dbUser?.premiumUntil);

  return (
    `Ism: ${fullName}\nUsername: ${username}\nTelegram ID: ${u.id}\n` +
    `Premium obuna: ${premium ? "BOR (premium kinolarni ham ko'ra oladi)" : "YO'Q (premium kinolarni ko'ra olmaydi)"}`
  );
}

function systemPrompt(context: string, userInfo: string): string {
  return (
    `Sen — "🎬 Kino vaqti" Telegram botining zamonaviy, aqlli va samimiy AI yordamchisisan. ` +
    `Vazifang: foydalanuvchiga kino/serial tanlashda yordam berish, savollariga javob berish va ularni xursand qilish.\n\n` +
    `━━━ FOYDALANUVCHI ━━━\n${userInfo}\n` +
    `Uni ismi bilan chaqir, samimiy va shaxsiy munosabatda bo'l. Agar o'z ID'si yoki profil ` +
    `ma'lumotlarini so'rasa (masalan "mening ID'im nima", "ismim nima") — yuqoridagi ma'lumotlarni ber.\n\n` +
    `━━━ TIL ━━━\n` +
    `• Foydalanuvchi QAYSI TILDA va QAYSI ALIFBODA yozsa (o'zbek lotin, o'zbek kirill, rus, ingliz va h.k.), ` +
    `SEN HAM AYNAN o'sha tilda va alifboda javob ber. Tilni har xabarda qayta aniqla — foydalanuvchi til ` +
    `almashtirsa, sen ham darhol almashtir.\n` +
    `• Til aniq bo'lmasa (masalan faqat raqam yozgan bo'lsa) — oldingi til bilan yoki o'zbek lotin ` +
    `alifbosida javob ber.\n\n` +
    `━━━ USLUB ━━━\n` +
    `• Javoblaringni CHIROYLI bezat: HTML teglaridan foydalanish mumkin — <b>qalin</b>, <i>kursiv</i>, <code>kod</code>.\n` +
    `• Mos emojilardan saxiylik bilan foydalan (🎬🍿🔥⭐️😍🎭🚀💥❤️🤖 va h.k.).\n` +
    `• Ro'yxatlarni chiroyli, tushunarli tuz. Uzun matndan qoch — jonli va qiziqarli bo'l.\n` +
    `• Markdown (** yoki ##) ISHLATMA — faqat HTML teglari.\n\n` +
    `━━━ KODLAR ━━━\n` +
    `• Har bir kino/serial kodi old qo'shimchali: kino uchun "m"+raqam (m12), serial uchun "s"+raqam (s7).\n` +
    `• Javobingda kodni HAR DOIM shu ko'rinishda yoz (m12, s7) — old qo'shimchasiz ishlatma.\n\n` +
    `━━━ KINO YUBORISH ━━━\n` +
    `• Foydalanuvchi BITTA kinoni HOZIR ko'rmoqchi bo'lsa ("shu kinoni ber", "Titanic yubor"): ` +
    `javob oxiriga [SEND:m12] yoki [SEND:s7] qo'sh — bot uni AVTOMATIK yuboradi. Bir nechta bo'lsa: [SEND:m12][SEND:s7].\n` +
    `• Foydalanuvchi BIR NECHTA kino so'rasa yoki RO'YXAT/TAVSIYA so'rasa ("5 ta kino tavsiya qil", "jangari kinolarni ko'rsat"): ` +
    `javob oxiriga barcha mos kodlarni bitta tegga jamlab yoz: [LIST:m12,s7,m88] — foydalanuvchiga chiroyli TUGMALI ` +
    `ro'yxat (sahifalash bilan) ko'rsatiladi.\n` +
    `• Bitta javobda HAM [SEND] HAM [LIST] ishlatma — vaziyatga qarab FAQAT bittasini tanla.\n` +
    `• Faqat yuqoridagi ro'yxatdagi mavjud kodlardan foydalan. Ro'yxatda yo'q bo'lsa — rostini ayt.\n\n` +
    `━━━ KINO HAQIDA MA'LUMOT ━━━\n` +
    `• Foydalanuvchi kino nomini yoki kodini yozsa (masalan "12" yoki "Titanic haqida aytib ber"), ` +
    `ro'yxatdagi MA'LUMOTLARDAN foydalanib chiroyli, to'liq javob ber: nomi, janri, yili, sifati, ` +
    `tili, davomiyligi, qisqa syujeti, ko'rishlar soni.\n` +
    `• Ma'lumotni quruq ro'yxat qilib emas, jonli va qiziqarli qilib yoz — odamda ko'rish istagi uyg'onsin.\n` +
    `• Keyin "Ko'rmoqchimisiz?" deb so'ra yoki darhol [SEND:...] bilan yubor (foydalanuvchi so'ragan bo'lsa).\n\n` +
    `━━━ 💎 PREMIUM KINOLAR ━━━\n` +
    `• Ro'yxatda 💎PREMIUM belgisi bor kinoni oddiy foydalanuvchi KO'RA OLMAYDI.\n` +
    `• Bunday kino so'ralsa: [SEND:...] ISHLATMA. Buning o'rniga kino haqida ` +
    `ishtiyoq uyg'otadigan, chiroyli tavsif yoz (nima uchun ajoyib, qanday janr, nimasi qiziq) — ` +
    `keyin samimiy tarzda premium obunani taklif qil: obuna bo'lsa shu kinoni va yana minglab ` +
    `kinolarni cheksiz, majburiy obunasiz ko'ra olishini ayt.\n` +
    `• Taklifni bosim o'tkazmasdan, do'stona va ishonarli qil. Oxirida <b>/premium</b> buyrug'ini eslat.\n` +
    `• Agar odamda premium bo'lsa — u baribir ko'ra oladi, shuning uchun oddiygina [SEND:...] bilan yubor.\n\n` +
    `━━━ BOT MA'LUMOTLARI ━━━\n` +
    `• Admin bilan bog'lanish: ${ADMIN_CONTACT}\n` +
    `• Rasmiy kanal: ${CHANNEL}\n` +
    `• Foydalanuvchi admin/kanal haqida so'rasa — shu ma'lumotlarni ber.\n\n` +
    `━━━ MAVJUD KONTENT ━━━\n${context}\n\n` +
    `Endi foydalanuvchiga eng yaxshi tarzda yordam ber!`
  );
}

/** Provayder zanjiri butunlay muvaffaqiyatsiz bo'lganda ko'rsatiladigan xabar — sabab bo'yicha aniqroq */
function aiFailureMessage(): string {
  return lastFailureWasRateLimited()
    ? "🤖 Hozir AI juda band — 1 daqiqadan so'ng qayta urinib ko'ring. 🙏"
    : "🤖 Kechirasiz, hozir AI javob bera olmadi. Birozdan keyin qayta urinib ko'ring.";
}

/**
 * AI matnini Telegram HTML uchun xavfsizlashtiradi. Model har doim toza HTML
 * chiqarmasligi mumkin (yopilmagan <b>, qochilmagan & < >) — bitta xato belgi
 * butun xabarni yubormay qo'yardi. Shuning uchun barcha teglar olib tashlanadi
 * va qolgan maxsus belgilar escape qilinadi: xabar hech qachon qulab tushmaydi,
 * foydalanuvchi xom teglarni ham ko'rmaydi.
 */
function sanitizeAiHtml(input: string): string {
  return e.escapeHtml(input.replace(/<[^>]*>/g, ""));
}

/**
 * Bitta AI muloqot navbatini bajaradi: limit tekshiruvi → kontekst → so'rov →
 * teg parsing ([SEND]/[LIST]) → yetkazish. `message:text` handleri va
 * qidiruvdan "seed" so'rov bilan kirish — ikkalasi ham shu funksiyani chaqiradi.
 */
async function runAiTurn(ctx: MyContext, text: string): Promise<void> {
  if (!(await checkAiAccess(ctx))) return;

  await ctx.replyWithChatAction("typing").catch(() => {});
  const [context, userInfo] = await Promise.all([buildContext(text), buildUserInfo(ctx)]);
  const history = getHistory(ctx);
  const answer = await askAIChat("user", {
    system: systemPrompt(context, userInfo),
    history,
    userText: text,
  });

  if (!answer) {
    await ctx.reply(aiFailureMessage());
    return;
  }

  // AI muvaffaqiyatli javob berdi — shundan keyingina so'rov hisoblanadi
  // (xato/rate-limit qaytgan so'rovlar kunlik kvotani yeb ketmasligi uchun).
  await countAiRequest(ctx);

  const listMatch = answer.match(/\[LIST:([^\]]+)\]/i);
  const display = answer
    .replace(/\[LIST:[^\]]+\]/gi, "")
    .replace(/\[SEND:[ms]?\d+\]/gi, "")
    .trim();

  // Suhbat tarixiga TOZALANGAN matn qo'shiladi — protokol teglari (ilgari xom
  // holda saqlanardi) modelga o'z boshqaruv sintaksisini qayta "o'qitmasin".
  pushHistory(ctx, text, display || answer);

  if (display) {
    await ctx.reply(sanitizeAiHtml(display)).catch(() => {});
  }

  if (listMatch) {
    const rawCodes = listMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const items = await resolveListItems(rawCodes);
    if (items.length) {
      ctx.session.scratch = { ...(ctx.session.scratch ?? {}), aiList: { items, page: 0 } };
      await renderAiList(ctx, false);
    }
    return;
  }

  // [SEND:...] — prefiks bor (m/s) yoki prefikssiz (default = kino)
  const codes: string[] = [];
  const re = /\[SEND:\s*([ms]?)(\d+)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) codes.push(`${m[1] || "m"}${m[2]}`);

  const unique = [...new Set(codes)].slice(0, 5);
  for (const code of unique) {
    await deliverPrefixedCode(ctx, code).catch(() => {});
  }
}

/** AI suhbatiga kiradi. `seedQuery` berilsa — salomlashish o'rniga darhol shu so'rovga javob generatsiya qilinadi. */
export async function enterAiChat(ctx: MyContext, seedQuery?: string): Promise<void> {
  if (!aiEnabled()) {
    await ctx.reply("🤖 AI yordamchi hozircha sozlanmagan. Keyinroq urinib ko'ring.");
    return;
  }

  // AI suhbatiga kirish — obuna/premium tekshiruvi (so'rov hisoblanmaydi).
  // Obuna bloklasa amalni (va seed so'rovni) eslab qolamiz — "Tekshirish"
  // bosilgach AI o'zi ochiladi va seed so'rovga javob beradi.
  const acc = await checkContentAccessResult(ctx, false);
  if (!acc.ok) {
    if (acc.reason === "sub") rememberPendingAction(ctx, { kind: "ai", seed: seedQuery });
    return;
  }

  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), aiChat: true };
  clearHistory(ctx); // yangi suhbat — tarix tozalanadi

  if (seedQuery) {
    await ctx.reply("🤖 <b>AI yordamchi</b> yoqildi — javob tayyorlanmoqda... 🔎", {
      reply_markup: aiActiveKeyboard(),
    });
    await runAiTurn(ctx, seedQuery);
    return;
  }

  await ctx.reply(
    `🤖 <b>AI yordamchi</b> — sizga xizmatda! ✨\n\n` +
      `Menga yozing yoki <b>kino posterini/rasmini yuboring</b> — tanib beraman!\n` +
      `🔥 <i>"Eng zo'r jangari kinoni ber"</i>\n` +
      `🚀 <i>"Kosmos haqida kino bormi?"</i>\n` +
      `🎭 <i>"5 ta komediya tavsiya qil"</i>\n` +
      `💬 yoki istalgan savolingizni yozing.\n\n` +
      `Men mos kinolarni topib, <b>to'g'ridan-to'g'ri yuborib</b> yoki chiroyli <b>tugmali ro'yxat</b> qilib beraman! 🎬\n\n` +
      `Chiqish uchun <b>${AI_EXIT}</b> tugmasini bosing.`,
    { reply_markup: aiActiveKeyboard() }
  );
}

aiUserHandler.hears(AI_BTN, (ctx) => enterAiChat(ctx));

// /ai komandasi — reply tugmasi bosilgani kabi AI suhbatiga kiradi
aiUserHandler.command("ai", (ctx) => enterAiChat(ctx));

// Start xabaridagi "AI yordamchi" inline tugmasi
aiUserHandler.callbackQuery("ai:enter", async (ctx) => {
  await ctx.answerCallbackQuery();
  await enterAiChat(ctx);
});

aiUserHandler.hears(AI_EXIT, async (ctx) => {
  if (ctx.session.scratch) delete ctx.session.scratch.aiChat;
  clearHistory(ctx);
  // Colonli "Asosiy menyu:" xabari hech narsani ochmaydi (keyboard bitta tugma) —
  // neytral chiqish xabari beriladi, reply keyboard asosiy menyuga qaytariladi.
  await ctx.reply("AI suhbatidan chiqdingiz. 👋", {
    reply_markup: userMenuKeyboard(),
  });
});

/**
 * "m12" / "s7" ko'rinishidagi kod bo'yicha kino yoki serialni yuboradi.
 * KVOTA BYPASS YOPILDI: ilgari bu funksiya gate'ni chetlab o'tardi — AI javobidagi
 * [SEND:] teglari bepul chegarani hisoblamay kino yuborardi. Endi to'liq gate
 * (obuna → bepul limit → premium) delivery.ts ichida, count bitta marotaba.
 */
async function deliverPrefixedCode(ctx: MyContext, raw: string): Promise<DeliverResult> {
  const type = raw[0];
  const num = Number(raw.slice(1));
  if (!Number.isInteger(num)) return { ok: true, reason: "ok", delivered: false, found: false };

  if (type === "s") {
    const serial = await prisma.serial.findUnique({ where: { code: num } });
    if (!serial) return { ok: true, reason: "ok", delivered: false, found: false };
    return deliverSerialSeasons(ctx, serial.id);
  }
  const movie = await prisma.movie.findUnique({ where: { code: num } });
  if (!movie) return { ok: true, reason: "ok", delivered: false, found: false };
  return deliverMovie(ctx, movie);
}

/** [LIST:...] tegidagi kodlarni DB'dan sarlavhalari bilan aniqlaydi (tartib va takrorsiz) */
async function resolveListItems(rawCodes: string[]): Promise<AiListItem[]> {
  const movieCodes: number[] = [];
  const serialCodes: number[] = [];
  const order: { type: "m" | "s"; code: number }[] = [];

  for (const rc of rawCodes) {
    const type = rc[0] === "s" ? "s" : "m";
    const num = Number(rc.slice(1));
    if (!Number.isInteger(num)) continue;
    if (type === "s") serialCodes.push(num);
    else movieCodes.push(num);
    order.push({ type, code: num });
  }

  const [movies, serials] = await Promise.all([
    movieCodes.length
      ? prisma.movie.findMany({
          where: { code: { in: movieCodes } },
          select: { code: true, title: true },
        })
      : Promise.resolve([]),
    serialCodes.length
      ? prisma.serial.findMany({
          where: { code: { in: serialCodes } },
          select: { code: true, title: true },
        })
      : Promise.resolve([]),
  ]);
  const mMap = new Map(movies.map((m) => [m.code, m.title]));
  const sMap = new Map(serials.map((s) => [s.code, s.title]));

  const items: AiListItem[] = [];
  const seen = new Set<string>();
  for (const o of order) {
    const key = `${o.type}${o.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = o.type === "s" ? sMap.get(o.code) : mMap.get(o.code);
    if (title) items.push({ type: o.type, code: o.code, title });
  }
  return items;
}

function buildListKeyboard(items: AiListItem[], page: number) {
  const start = page * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);

  const rows = pageItems.map((it) => [
    ibtn(
      `${it.type === "s" ? "📺" : "🎬"} ${it.title}`,
      `ai:watch:${it.type}${it.code}`,
      it.type === "s" ? "success" : "primary"
    ),
  ]);

  const totalPages = Math.ceil(items.length / PAGE_SIZE);
  if (totalPages > 1) {
    const nav: ReturnType<typeof ibtn>[] = [];
    // SAHIFALASH — navigatsiya EMAS. Ilgari "Orqaga" deb nomlangan edi va
    // "◀️ Orqaga" (oldingi ekranga qaytish) bilan chalkashardi.
    if (page > 0) nav.push(ibtn("⬅️ Oldingi", `ai:pg:${page - 1}`, "primary"));
    nav.push(ibtn(`${page + 1}/${totalPages}`, "noop:ai"));
    if (page < totalPages - 1) nav.push(ibtn("Keyingi ➡️", `ai:pg:${page + 1}`, "success"));
    rows.push(nav);
  }
  rows.push([ibtn("❌ Yopish", "ai:close", "danger")]);

  return kb(...rows);
}

/** Ro'yxat sessiyadan topilmasa — jimgina qaytmaslik (dead-flow) */
function aiListStaleMessage(): string {
  return "ℹ️ Ro'yxat eskirgan. AI'dan qaytadan so'rang.";
}

async function renderAiList(ctx: MyContext, edit: boolean) {
  const state = ctx.session.scratch?.aiList as { items: AiListItem[]; page: number } | undefined;
  if (!state) {
    await ctx.reply(aiListStaleMessage());
    return;
  }
  const markup = buildListKeyboard(state.items, state.page);

  if (edit) {
    await ctx.editMessageReplyMarkup({ reply_markup: markup }).catch(() => {});
  } else {
    // Sarlavha video ostidagi tugma bilan bitta nom ("Sizga yoqishi mumkin")
    // — bir xil tavsiya tushunchasi turli nomlar bilan atalmasin.
    await ctx.reply(`${ce("star")} <b>Sizga yoqishi mumkin</b> (${state.items.length} ta):`, {
      reply_markup: markup,
    });
  }
}

aiUserHandler.on("message:text", async (ctx, next) => {
  if (!ctx.session.scratch?.aiChat) return next();

  const text = ctx.message.text.trim();
  if (text.startsWith("/")) {
    if (ctx.session.scratch) delete ctx.session.scratch.aiChat;
    clearHistory(ctx);
    return next();
  }

  // Aniq kino/serial kodi (faqat raqam) — foydalanuvchi AI'dan emas, oddiy
  // qidiruvdan foydalanmoqchi. AI rejimidan jimgina chiqamiz va odatdagi
  // qidiruv oqimiga o'tkazamiz.
  if (/^\d+$/.test(text)) {
    if (ctx.session.scratch) delete ctx.session.scratch.aiChat;
    clearHistory(ctx);
    return next();
  }

  await runAiTurn(ctx, text);
});

// ─── Rasm orqali kino topish (vision) ────────────────────────────────────────
// Rasm AI rejimida ham, undan TASHQARIDA ham ishlaydi: foydalanuvchi botga
// poster tashlasa, uni tanishini kutadi — ilgari AI rejimiga kirmagan bo'lsa
// bot umuman javob bermay, jim qolardi.
async function handlePhotoSearch(ctx: MyContext): Promise<void> {
  if (!visionEnabled()) {
    await ctx.reply("🖼 Kechirasiz, rasm orqali qidirish uchun vision-AI sozlanmagan.");
    return;
  }

  // AI so'rovi limiti (rasm ham AI so'rovi sifatida hisoblanadi) — GATE faqat.
  // Hisob muvaffaqiyatli javobdan keyin oshiriladi (xato javob kvotani yemasligi uchun).
  if (!(await checkAiAccess(ctx))) return;

  await ctx.replyWithChatAction("typing").catch(() => {});

  // Rasmni yuklab olish → data URL
  const photo = ctx.message!.photo!.at(-1)!;
  let dataUrl: string | null = null;
  try {
    const file = await ctx.api.getFile(photo.file_id);
    const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const fileRes = await fetch(url);
    const buf = Buffer.from(await fileRes.arrayBuffer());
    const mime = fileRes.headers.get("content-type") || "image/jpeg";
    dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    await ctx.reply("❌ Rasmni yuklab bo'lmadi. Qaytadan urinib ko'ring.");
    return;
  }

  const visionPrompt =
    `Ushbu rasm — kino yoki serial posteri/kadri. Qaysi kino/serial ekanini ANIQLA. ` +
    `Faqat quyidagi formatda javob ber (boshqa hech narsa yozma):\n` +
    `TITLE: <original yoki eng mashhur nomi>\nYEAR: <yili yoki ->\nINFO: <bir jumla qisqa ma'lumot>`;

  const answer = await askVision({ userText: visionPrompt, imageDataUrl: dataUrl });
  if (!answer) {
    await ctx.reply("🤖 Rasmni taniy olmadim. Boshqa/tiniqroq rasm yuboring yoki nomini yozing.");
    return;
  }

  // Rasm tanish muvaffaqiyatli — AI so'rovi shundan keyingina hisoblanadi
  await countAiRequest(ctx);

  const title = answer.match(/TITLE:\s*(.+)/i)?.[1]?.trim();
  const year = answer.match(/YEAR:\s*(.+)/i)?.[1]?.trim();
  const info = answer.match(/INFO:\s*(.+)/i)?.[1]?.trim();

  if (!title) {
    await ctx.reply(e.escapeHtml(answer));
    return;
  }

  // Bazadan qidirish (nom bo'yicha) — kino VA serial ikkalasi ham tekshiriladi
  const [foundMovie, foundSerial] = await Promise.all([
    prisma.movie.findFirst({
      where: { title: { contains: title, mode: "insensitive" } },
      orderBy: { views: "desc" },
    }),
    prisma.serial.findFirst({
      where: { title: { contains: title, mode: "insensitive" } },
      orderBy: { views: "desc" },
    }),
  ]);

  await ctx.reply(
    `${ce("search")} Rasmda: <b>${e.escapeHtml(title)}</b>` +
      (year && year !== "-" ? ` (${e.escapeHtml(year)})` : "") +
      (info ? `\n<i>${e.escapeHtml(info)}</i>` : "")
  );

  if (foundMovie) {
    await deliverMovie(ctx, foundMovie);
  } else if (foundSerial) {
    await deliverSerialSeasons(ctx, foundSerial.id);
  } else {
    await ctx.reply(
      `ℹ️ Bu kino/serial hozircha <b>bazamizda yo'q</b>. Nomi bo'yicha qidirib ko'ring yoki keyinroq qo'shilishi mumkin.`
    );
  }
}

aiUserHandler.on("message:photo", async (ctx, next) => {
  // To'lov cheki kutilayotgan bo'lsa — bu rasm premium oqimiga tegishli, aralashmaymiz
  if (ctx.session.scratch?.premBuyTariff) return next();
  // Admin broadcast qoralamasi tayyorlayotgan bo'lsa ham tegmaymiz
  if (ctx.session.scratch?.bcast) return next();
  await handlePhotoSearch(ctx);
});

// ─── AI ro'yxat knopkalari ────────────────────────────────────────────────────

aiUserHandler.callbackQuery("noop:ai", (ctx) => ctx.answerCallbackQuery());

aiUserHandler.callbackQuery(/^ai:watch:([ms]\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  // To'liq gate + bitta count delivery.ts ichida — bu yerda QAYTA tekshirish
  // (checkContentAccess) ikki marta hisoblashga olib kelardi.
  const result = await deliverPrefixedCode(ctx, ctx.match[1]).catch(() => null);
  // Kod bazada yo'q — jimgina hech narsa bo'lmasin, foydalanuvchiga aytamiz.
  if (result && !result.delivered && !result.found) {
    await ctx.reply("ℹ️ Kechirasiz, bu kino/serial hozircha mavjud emas.");
  }
});

aiUserHandler.callbackQuery(/^ai:pg:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const state = ctx.session.scratch?.aiList as { items: AiListItem[]; page: number } | undefined;
  if (!state) {
    await ctx.reply(aiListStaleMessage());
    return;
  }
  state.page = Number(ctx.match[1]);
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), aiList: state };
  await renderAiList(ctx, true);
});

aiUserHandler.callbackQuery("ai:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.session.scratch) delete ctx.session.scratch.aiList;
  await ctx.deleteMessage().catch(() => {});
});
