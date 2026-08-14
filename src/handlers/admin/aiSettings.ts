import { Composer } from "grammy";
import { adminCan } from "../../config.js";
import { BE, BOT_SETTINGS_TEXT, backBtn, ibtn, kb } from "../../utils/keyboard.js";
import { getSetting, setSetting, KEYS } from "../../utils/settings.js";
import {
  PROVIDERS,
  availableProviders,
  rateLimitSnapshot,
  lastProviderError,
} from "../../services/ai.js";
import { todayUsage } from "../../services/aiUsage.js";
import type { MyContext } from "../../types.js";

export const aiSettingsHandler = new Composer<MyContext>();

function scopeKey(scope: "u" | "a") {
  return scope === "a" ? KEYS.aiAdminModel : KEYS.aiUserModel;
}
function scopeLabel(scope: "u" | "a") {
  return scope === "a" ? "Admin AI" : "Foydalanuvchi AI";
}

function modelLabel(value: string): string {
  if (!value.includes(":")) return "avtomatik (fallback)";
  const [pid, ...rest] = value.split(":");
  const model = rest.join(":");
  const p = PROVIDERS.find((x) => x.id === pid);
  const m = p?.models.find((x) => x.id === model);
  return `${p?.label ?? pid} · ${m?.label ?? model}`;
}

async function renderPanel(ctx: MyContext, edit: boolean) {
  const usage = await todayUsage();
  const [userModel, adminModel] = await Promise.all([
    getSetting(KEYS.aiUserModel, ""),
    getSetting(KEYS.aiAdminModel, ""),
  ]);

  const avail = availableProviders();
  const lines: string[] = [
    `<tg-emoji emoji-id="${BE.settings}">⚙️</tg-emoji> <b>AI sozlamalari</b>`,
    ``,
    `<b>Faol modellar:</b>`,
    `👤 Foydalanuvchi: <b>${modelLabel(userModel)}</b>`,
    `🛡 Admin: <b>${modelLabel(adminModel)}</b>`,
    ``,
    `<b>Bugungi sarf (provayder bo'yicha):</b>`,
  ];

  if (PROVIDERS.length === 0) lines.push("—");
  for (const p of PROVIDERS) {
    const has = !!p.key();
    const u = usage[p.id];
    const rl = rateLimitSnapshot.get(p.id);
    const err = lastProviderError.get(p.id);
    let line = `${has ? "🟢" : "⚪️"} <b>${p.label}</b>`;
    if (u) line += ` — ${u.requests} so'rov, ${u.tokens} token`;
    else if (has) line += " — bugun ishlatilmagan";
    else line += " — kalit yo'q";
    // rate-limit qoldig'i (agar bor bo'lsa)
    const remReq = rl?.["x-ratelimit-remaining-requests"];
    const remTok = rl?.["x-ratelimit-remaining-tokens"];
    if (remReq || remTok) {
      line += `\n   qoldiq: ${remReq ?? "?"} so'rov, ${remTok ?? "?"} token`;
    }
    if (err) line += `\n   ⚠️ ${err.slice(0, 80)}`;
    lines.push(line);
  }

  const rows = [
    [
      ibtn("👤 Foydalanuvchi modeli", "aiset:scope:u", "primary"),
      ibtn("🛡 Admin modeli", "aiset:scope:a", "primary"),
    ],
    [ibtn("🔄 Yangilash", "aiset:open", "success")],
    [backBtn("botset:back")],
  ];
  if (avail.length === 0) {
    lines.push("", "⚠️ Hech qanday AI provayder kaliti sozlanmagan.");
  }

  const text = lines.join("\n");
  if (edit) await ctx.editMessageText(text, { reply_markup: kb(...rows) }).catch(() => {});
  else await ctx.reply(text, { reply_markup: kb(...rows) });
}

aiSettingsHandler.hears(BOT_SETTINGS_TEXT.ai, async (ctx) => {
  if (!adminCan(ctx.from!.id, "ai")) return;
  await renderPanel(ctx, false);
});

aiSettingsHandler.callbackQuery("aiset:open", async (ctx) => {
  if (!adminCan(ctx.from.id, "ai")) {
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.answerCallbackQuery();
  await renderPanel(ctx, true);
});

aiSettingsHandler.callbackQuery("aiset:back", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});

// Scope tanlandi → provayderlar ro'yxati
aiSettingsHandler.callbackQuery(/^aiset:scope:(u|a)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const scope = ctx.match[1] as "u" | "a";
  const avail = availableProviders();

  const rows = avail.map((p) => {
    const idx = PROVIDERS.indexOf(p);
    return [ibtn(p.label, `aiset:prov:${scope}:${idx}`, "primary")];
  });
  rows.push([ibtn("♻️ Avtomatik (fallback)", `aiset:auto:${scope}`, "success")]);
  rows.push([backBtn("aiset:open")]);

  await ctx
    .editMessageText(`<b>${scopeLabel(scope)}</b> uchun provayderni tanlang:`, {
      reply_markup: kb(...rows),
    })
    .catch(() => {});
});

// Provayder tanlandi → modellar ro'yxati
aiSettingsHandler.callbackQuery(/^aiset:prov:(u|a):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const scope = ctx.match[1] as "u" | "a";
  const pIdx = Number(ctx.match[2]);
  const p = PROVIDERS[pIdx];
  if (!p) return;

  const rows = p.models.map((m, mIdx) => [
    ibtn(m.label, `aiset:set:${scope}:${pIdx}:${mIdx}`, "primary"),
  ]);
  rows.push([backBtn(`aiset:scope:${scope}`)]);

  await ctx
    .editMessageText(`<b>${scopeLabel(scope)}</b> · <b>${p.label}</b>\n\nModelni tanlang:`, {
      reply_markup: kb(...rows),
    })
    .catch(() => {});
});

// Model tanlandi → saqlash
aiSettingsHandler.callbackQuery(/^aiset:set:(u|a):(\d+):(\d+)$/, async (ctx) => {
  const scope = ctx.match[1] as "u" | "a";
  const p = PROVIDERS[Number(ctx.match[2])];
  const m = p?.models[Number(ctx.match[3])];
  if (!p || !m) {
    await ctx.answerCallbackQuery();
    return;
  }
  await setSetting(scopeKey(scope), `${p.id}:${m.id}`);
  await ctx.answerCallbackQuery({
    text: `✅ ${scopeLabel(scope)}: ${p.label} · ${m.label}`,
    show_alert: true,
  });
  await renderPanel(ctx, true);
});

// Avtomatik (fallback) rejim
aiSettingsHandler.callbackQuery(/^aiset:auto:(u|a)$/, async (ctx) => {
  const scope = ctx.match[1] as "u" | "a";
  await setSetting(scopeKey(scope), "");
  await ctx.answerCallbackQuery({
    text: `✅ ${scopeLabel(scope)}: avtomatik fallback`,
    show_alert: true,
  });
  await renderPanel(ctx, true);
});
