import type { NextFunction } from "grammy";
import { prisma } from "../prisma.js";
import { isAdmin } from "../config.js";
import type { MyContext } from "../types.js";

/** Har bir foydalanuvchini bazaga yozadi / yangilaydi (statistika uchun) */
export async function trackUser(ctx: MyContext, next: NextFunction) {
  const from = ctx.from;
  if (from && !from.is_bot) {
    try {
      await prisma.user.upsert({
        where: { id: BigInt(from.id) },
        create: {
          id: BigInt(from.id),
          firstName: from.first_name,
          username: from.username,
          isAdmin: isAdmin(from.id),
        },
        update: {
          firstName: from.first_name,
          username: from.username,
          isAdmin: isAdmin(from.id),
          // Foydalanuvchi botga murojaat qilyapti — demak bloklamagan.
          // Ommaviy yuborishda tarmoq xatosi tufayli noto'g'ri belgilangan
          // bo'lsa, shu yerda o'zi tiklanadi.
          isBlocked: false,
        },
      });
    } catch {
      // statistika xatosi botni to'xtatmasin
    }
  }
  await next();
}
