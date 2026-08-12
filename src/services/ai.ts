import { config } from "../config.js";
import { getSetting, KEYS } from "../utils/settings.js";

// ─────────────────────────────────────────────────────────────────────────────
// AI PROVAYDER REGISTRI
// Barcha provayderlar (Gemini'dan tashqari) OpenAI-mos chat completions API.
// Kalit yo'q provayder avtomatik "mavjud emas" bo'ladi.
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderId = "groq" | "openrouter" | "cerebras" | "github" | "mistral" | "gemini";

interface Provider {
  id: ProviderId;
  label: string;
  style: "openai" | "gemini";
  baseUrl: string; // OpenAI-mos uchun to'liq chat completions URL
  key: () => string; // API kalit (bo'sh bo'lsa — mavjud emas)
  models: { id: string; label: string }[];
}

export const PROVIDERS: Provider[] = [
  {
    id: "groq",
    label: "Groq",
    style: "openai",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    key: () => config.groqApiKey,
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (sifatli)" },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B (tez, katta limit)" },
      { id: "groq/compound-mini", label: "Compound Mini" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    style: "openai",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    key: () => config.openrouterApiKey,
    models: [
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra 550B (free)" },
      { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B — rasm ham (free)" },
      {
        id: "nvidia/nemotron-nano-12b-v2-vl:free",
        label: "Nemotron Nano 12B VL — rasm ham (free)",
      },
      { id: "openrouter/free", label: "OpenRouter Auto (free)" },
    ],
  },
  {
    id: "cerebras",
    label: "Cerebras",
    style: "openai",
    baseUrl: "https://api.cerebras.ai/v1/chat/completions",
    key: () => config.cerebrasApiKey,
    models: [
      { id: "llama-3.3-70b", label: "Llama 3.3 70B (juda tez)" },
      { id: "llama3.1-8b", label: "Llama 3.1 8B" },
    ],
  },
  {
    id: "github",
    label: "GitHub Models",
    style: "openai",
    baseUrl: "https://models.github.ai/inference/chat/completions",
    key: () => config.githubModelsToken,
    models: [
      { id: "openai/gpt-4.1-mini", label: "GPT-4.1 mini — eng sifatli, rasm ham" },
      { id: "openai/gpt-4o-mini", label: "GPT-4o mini — rasm ham" },
      { id: "openai/gpt-4o", label: "GPT-4o — kuchli, limit past" },
      { id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
    ],
  },
  {
    id: "mistral",
    label: "Mistral",
    style: "openai",
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    key: () => config.mistralApiKey,
    models: [
      { id: "mistral-large-latest", label: "Mistral Large" },
      { id: "mistral-small-latest", label: "Mistral Small" },
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    style: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    key: () => config.geminiApiKey,
    // Gemini 2.0 oilasi 2026-06-01 da BUTUNLAY o'chirilgan (404 "no longer
    // available") — prodda har bir Gemini so'rovi shu yerda yiqilardi.
    // 3.x tanlandi: 2.5 uchun 2026-10-16 da yana majburiy ko'chish bor.
    models: [
      { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash — rasm ham" },
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite (arzon)" },
    ],
  },
];

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Kaliti bor (mavjud) provayderlar */
export function availableProviders(): Provider[] {
  return PROVIDERS.filter((p) => !!p.key());
}

/** Biror provayder kaliti bormi? */
export function aiEnabled(): boolean {
  return availableProviders().length > 0;
}

/** So'nggi rate-limit holati (header'lardan) — panel uchun */
export const rateLimitSnapshot = new Map<ProviderId, Record<string, string>>();
/** So'nggi xato (panel uchun) */
export const lastProviderError = new Map<ProviderId, string>();

/** So'nggi urinishlarning barchasi 429 (limit) bilan tugadimi — foydalanuvchiga aniqroq xabar berish uchun */
export function lastFailureWasRateLimited(): boolean {
  for (const msg of lastProviderError.values()) {
    if (/\b429\b/.test(msg)) return true;
  }
  return false;
}

interface AiResult {
  text: string;
  provider: ProviderId;
  model: string;
  tokens: number;
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export interface AiCallOpts {
  system?: string;
  history?: ChatMsg[];
  userText: string;
  imageDataUrl?: string; // "data:image/jpeg;base64,...."
  maxTokens?: number; // standart 800; qisqa ichki so'rovlar (masalan kalit so'z ajratish) uchun kamaytiriladi
}

// 12s Mistral Large uchun kam edi — prodda har safar "This operation was
// aborted" bilan uzilib, provayder amalda hech qachon javob bermasdi.
const REQUEST_TIMEOUT_MS = 25_000;

async function fetchOnce(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Timeout bilan so'rov + tranzient xatoda (tarmoq, 429, 5xx) BITTA tezkor qayta urinish */
async function fetchResilient(url: string, init: RequestInit): Promise<Response> {
  try {
    const res = await fetchOnce(url, init);
    if (res.ok || (res.status !== 429 && res.status < 500)) return res;
    return await fetchOnce(url, init);
  } catch {
    return await fetchOnce(url, init); // ikkinchi urinish ham otilsa — tashqi catch tutadi
  }
}

// Vision-qobiliyatli modellar (ustuvorlik tartibida). Faqat kaliti bor bo'lsa ishlatiladi.
//
// DIQQAT: bu ro'yxatdagi modellar 2026-07-29 da jonli sinovdan o'tkazilgan —
// haqiqiy rasm yuborilib, javob to'g'riligi tekshirilgan. Bepul model nomlari
// tez-tez o'zgaradi (eski ro'yxatdagi hammasi 404/429 bergan va rasm orqali
// qidiruv umuman ishlamay qolgan edi), shuning uchun o'zgartirishdan oldin
// har bir modelni albatta sinab ko'ring.
//
// "Reasoning" modellari ataylab qo'shilmagan — ular javobga <think> kabi
// izohlarni aralashtirib, TITLE:/YEAR:/INFO: formatini buzadi.
// Groq'da 2026-07 holatiga ko'ra umuman vision modeli yo'q.
// Tartib SIFAT bo'yicha: kino posterini tanish og'ir vazifa, shuning uchun eng
// kuchli model birinchi. Rasm so'rovlari kam bo'lgani uchun GitHub Models'ning
// past kunlik limiti bu yerda muammo emas (matn oqimida esa Groq birinchi
// turadi — u yerda hajm muhimroq).
// TARTIB: GitHub Models 410 "retirement brownout" qaytaryapti (servis yopilmoqda),
// shuning uchun u boshdan OXIRGA ko'chirildi — ilgari zanjirning ikkita birinchi
// bandi ham o'sha yerda edi va rasm qidiruvi hech qachon ishlamasdi.
const VISION_MODELS: { provider: ProviderId; model: string }[] = [
  { provider: "gemini", model: "gemini-3.6-flash" },
  { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" },
  { provider: "openrouter", model: "nvidia/nemotron-nano-12b-v2-vl:free" },
  { provider: "mistral", model: "pixtral-12b-latest" },
  { provider: "openrouter", model: "openrouter/free" },
  { provider: "github", model: "openai/gpt-4.1-mini" },
  { provider: "github", model: "openai/gpt-4o-mini" },
];

function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  return m ? { mime: m[1], base64: m[2] } : null;
}

// ─── OpenAI-mos so'rov (tarix + rasm) ────────────────────────────────────────
async function callOpenAI(p: Provider, model: string, opts: AiCallOpts): Promise<AiResult | null> {
  try {
    // Oxirgi user xabar: rasm bo'lsa parts massivi, aks holda oddiy string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let userContent: any = opts.userText;
    if (opts.imageDataUrl) {
      userContent = [
        { type: "text", text: opts.userText },
        { type: "image_url", image_url: { url: opts.imageDataUrl } },
      ];
    }
    const messages = [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      ...(opts.history ?? []).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userContent },
    ];

    const res = await fetchResilient(p.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key()}` },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: opts.maxTokens ?? 800,
      }),
    });

    const rl: Record<string, string> = {};
    for (const [k, v] of res.headers.entries()) {
      if (k.toLowerCase().startsWith("x-ratelimit")) rl[k] = v;
    }
    if (Object.keys(rl).length) rateLimitSnapshot.set(p.id, rl);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const msg = `${res.status} ${res.statusText} — ${body.slice(0, 300)}`;
      lastProviderError.set(p.id, msg);
      console.error(`🤖 ${p.label} (${model}) xato: ${msg}`);
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) return null;
    const tokens = data?.usage?.total_tokens ?? 0;
    lastProviderError.delete(p.id);
    return { text: text.trim(), provider: p.id, model, tokens };
  } catch (err) {
    lastProviderError.set(p.id, (err as Error).message);
    console.error(`🤖 ${p.label} (${model}) so'rov xatosi:`, (err as Error).message);
    return null;
  }
}

// ─── Gemini so'rov (tarix + rasm) ────────────────────────────────────────────
async function callGemini(p: Provider, model: string, opts: AiCallOpts): Promise<AiResult | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contents: any[] = (opts.history ?? []).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lastParts: any[] = [{ text: opts.userText }];
    if (opts.imageDataUrl) {
      const img = parseDataUrl(opts.imageDataUrl);
      if (img) lastParts.push({ inlineData: { mimeType: img.mime, data: img.base64 } });
    }
    contents.push({ role: "user", parts: lastParts });

    const url = `${p.baseUrl}/${model}:generateContent?key=${p.key()}`;
    const res = await fetchResilient(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
        generationConfig: { temperature: 0.7, maxOutputTokens: opts.maxTokens ?? 800 },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const msg = `${res.status} ${res.statusText} — ${body.slice(0, 300)}`;
      lastProviderError.set(p.id, msg);
      console.error(`🤖 Gemini (${model}) xato: ${msg}`);
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return null;
    const text = parts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((x: any) => x.text ?? "")
      .join("")
      .trim();
    if (!text) return null;
    const tokens = data?.usageMetadata?.totalTokenCount ?? 0;
    lastProviderError.delete(p.id);
    return { text, provider: p.id, model, tokens };
  } catch (err) {
    lastProviderError.set(p.id, (err as Error).message);
    console.error(`🤖 Gemini (${model}) so'rov xatosi:`, (err as Error).message);
    return null;
  }
}

async function callProvider(
  p: Provider,
  model: string,
  opts: AiCallOpts
): Promise<AiResult | null> {
  if (!p.key()) return null;
  return p.style === "gemini" ? callGemini(p, model, opts) : callOpenAI(p, model, opts);
}

/** Matn scope uchun sinov tartibi: sozlangan model + har mavjud provayder models[0] */
async function buildTextOrder(scope: "user" | "admin"): Promise<{ p: Provider; model: string }[]> {
  const available = availableProviders();
  const selected = await getSetting(scope === "admin" ? KEYS.aiAdminModel : KEYS.aiUserModel, "");
  const tried = new Set<string>();
  const order: { p: Provider; model: string }[] = [];

  if (selected.includes(":")) {
    const [pid, ...rest] = selected.split(":");
    const model = rest.join(":");
    const p = available.find((x) => x.id === pid);
    if (p && model) {
      order.push({ p, model });
      tried.add(`${pid}:${model}`);
    }
  }
  for (const p of available) {
    const model = p.models[0]?.id;
    if (!model) continue;
    const kk = `${p.id}:${model}`;
    if (tried.has(kk)) continue;
    order.push({ p, model });
    tried.add(kk);
  }
  return order;
}

async function runChain(
  order: { p: Provider; model: string }[],
  opts: AiCallOpts
): Promise<string | null> {
  if (order.length === 0) {
    console.error("🤖 AI so'rovi keldi, lekin mos provayder yo'q!");
    return null;
  }
  for (const { p, model } of order) {
    const r = await callProvider(p, model, opts);
    if (r) {
      recordUsage(r.provider, r.model, r.tokens);
      return r.text;
    }
  }
  return null;
}

/** Ko'p bosqichli (tarixli) matn so'rovi */
export async function askAIChat(scope: "user" | "admin", opts: AiCallOpts): Promise<string | null> {
  const order = await buildTextOrder(scope);
  return runChain(order, opts);
}

/** Oddiy bir martalik matn so'rovi (eski imzo saqlanadi) */
export async function askAI(
  scope: "user" | "admin",
  userText: string,
  system?: string
): Promise<string | null> {
  return askAIChat(scope, { userText, system });
}

/** Rasm (vision) so'rovi — faqat vision-qobiliyatli mavjud modellar sinaladi */
export async function askVision(opts: AiCallOpts): Promise<string | null> {
  const order: { p: Provider; model: string }[] = [];
  for (const vm of VISION_MODELS) {
    const p = getProvider(vm.provider);
    if (p && p.key()) order.push({ p, model: vm.model });
  }
  if (order.length === 0) {
    console.error("🤖 Vision so'rovi keldi, lekin vision-qobiliyatli provayder kaliti yo'q!");
    return null;
  }
  return runChain(order, opts);
}

/** Vision imkoniyati bormi (biror vision-provayder kaliti bor) */
export function visionEnabled(): boolean {
  return VISION_MODELS.some((vm) => {
    const p = getProvider(vm.provider);
    return p && !!p.key();
  });
}

// ─── Usage tracking (B2'da DB'ga ulanadi; hozircha callback) ─────────────────
type UsageSink = (provider: ProviderId, model: string, tokens: number) => void;
let usageSink: UsageSink | null = null;
export function setUsageSink(sink: UsageSink) {
  usageSink = sink;
}
function recordUsage(provider: ProviderId, model: string, tokens: number) {
  try {
    usageSink?.(provider, model, tokens);
  } catch {
    /* ignore */
  }
}
