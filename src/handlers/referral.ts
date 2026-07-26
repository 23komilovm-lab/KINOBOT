import { Composer } from "grammy";
import { getReferralCount, getReferralReward } from "../utils/referral.js";
import { kb } from "../utils/keyboard.js";
import type { MyContext } from "../types.js";

export const referralHandler = new Composer<MyContext>();

export async function sendReferralInfo(ctx: MyContext): Promise<void> {
  const uid  = ctx.from!.id;
  const link = `https://t.me/${ctx.me.username}?start=ref_${uid}`;
  const [count, reward] = await Promise.all([getReferralCount(uid), getReferralReward()]);

  const markup = kb([
    { text: "Do'stlarga yuborish", switch_inline_query: `ref_${uid}`, icon_custom_emoji_id: "5260450573768990626" },
  ]);

  // Mukofot sozlangan bo'lsagina va'da qilamiz — aks holda bajarilmaydigan
  // va'da bo'lib qoladi (ilgari matn har doim "mukofot olasiz" derdi).
  const rewardOn = reward.count > 0 && reward.days > 0;
  const head = rewardOn
    ? `<tg-emoji emoji-id="5258513401784573443">📈</tg-emoji> <b>Do'st taklif qiling — Premium yutib oling!</b>\n\n` +
      `Har <b>${reward.count}</b> ta a'zo bo'lgan do'stingiz uchun <b>${reward.days} kun Premium</b> sovg'a qilinadi.\n\n`
    : `<tg-emoji emoji-id="5258513401784573443">📈</tg-emoji> <b>Do'stlaringizni taklif qiling!</b>\n\n` +
      `Havolangiz orqali qo'shilgan har bir do'st hisobingizda ko'rinadi.\n\n`;

  const progress = rewardOn
    ? `👥 Referallaringiz: <b>${count}</b> ta — keyingi sovg'agacha <b>${reward.count - (count % reward.count)}</b> ta qoldi\n\n`
    : `👥 Referallaringiz: <b>${count}</b> ta\n\n`;

  await ctx.reply(
    head + progress +
    `<tg-emoji emoji-id="5260730055880876557">🔗</tg-emoji> Sizning havolangiz:\n<code>${link}</code>\n\n` +
    `<i>Tugma orqali do'stlaringizga yuboring yoki havolani ulashing. Ular botga kirib kanallarga a'zo bo'lgach, referal hisoblanadi.</i>`,
    { reply_markup: markup }
  );
}

referralHandler.command("referal", sendReferralInfo);
