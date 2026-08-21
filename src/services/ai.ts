import { config } from "../config.js";
import { getSetting, KEYS } from "../utils/settings.js";

// ─────────────────────────────────────────────────────────────────────────────
// AI PROVAYDER REGISTRI
// Barcha provayderlar OpenAI-mos chat completions API.
// Kalit yo'q provayder avtomatik "mavjud emas" bo'ladi.
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderId = "groq" | "openrouter" | "mistral";

interface Provider {
  id: ProviderId;
  label: string;
  baseUrl: string; // to'liq chat completions URL
  key: () => string; // API kalit (bo'sh bo'lsa — mavjud emas)
  models: { id: string; label: string }[];
}

export const PROVIDERS: Provider[] = [
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    key: () => config.groqApiKey,
    // Llama modellar (llama-3.3-70b-versatile, llama-3.1-8b-instant) Groq'dan
    // OLIB TASHLANGAN (2026-08-21) — prodda har bir so'rov 404 model_not_found
    // berardi. O'rniga gpt-oss oilasi qo'yildi — jonli sinovdan o'tgan
    // (reasoning alohida maydonda qaytadi, content toza qoladi).
    models: [
      { id: "openai/gpt-oss-120b", label: "GPT OSS 120B (sifatli)" },
      { id: "openai/gpt-oss-20b", label: "GPT OSS 20B (tez)" },
      { id: "groq/compound-mini", label: "Compound Mini" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
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
  // Cerebras va GitHub Models OLIB TASHLANDI (2026-08-12):
  //  - GitHub Models 410 "github_models_retirement_brownout" qaytaradi, servis
  //    yopilmoqda — kalit ham yordam bermaydi.
  //  - Cerebras kaliti hech qachon o'rnatilmagan edi, egasi kerak emas dedi.
  // O'lik provayder zanjirda turishi har so'rovni sekinlashtiradi va loglarni
  // shovqin bilan to'ldiradi.
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    key: () => config.mistralApiKey,
    models: [
      { id: "mistral-large-latest", label: "Mistral Large" },
      { id: "mistral-small-latest", label: "Mistral Small" },
    ],
  },
  // Google Gemini OLIB TASHLANDI (2026-08-21):
  //  - Avval 2.0 oilasi o'chirilgandi (2026-06-01), 3.x ga o'tilgandi.
  //  - Endi Google loyiha o'zi BLOKLANGAN — har bir so'rov 403
  //    PERMISSION_DENIED "Your project has been denied access" qaytaradi.
  //    Kalitni almashtirish uchun yangi Google Cloud loyihasi kerak; qayta
  //    qo'shishda git tarixidagi eski Provider blokidan nusxa olish yetarli.
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
// DIQQAT: bepul model nomlari tez-tez o'zgaradi — o'zgartirishdan oldin har bir
// modelni jonli rasm bilan albatta sinab ko'ring.
//
// "Reasoning" modellari ataylab qo'shilmagan — ular javobga <think> kabi
// izohlarni aralashtirib, TITLE:/YEAR:/INFO: formatini buzadi.
// Gemini bandi OLIB TASHLANDI (2026-08-21) — Google loyihasi bloklangan (403).
const VISION_MODELS: { provider: ProviderId; model: string }[] = [
  { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" },
  { provider: "openrouter", model: "nvidia/nemotron-nano-12b-v2-vl:free" },
  { provider: "mistral", model: "pixtral-12b-latest" },
  { provider: "openrouter", model: "openrouter/free" },
];

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

async function callProvider(
  p: Provider,
  model: string,
  opts: AiCallOpts
): Promise<AiResult | null> {
  if (!p.key()) return null;
  return callOpenAI(p, model, opts);
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
