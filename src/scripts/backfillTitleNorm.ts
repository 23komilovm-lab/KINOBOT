/**
 * BIR MARTALIK SKRIPT: mavjud kino/serial qatorlarini `titleNorm` bilan to'ldiradi.
 *
 * Nima uchun: aqlli qidiruv (search.ts) 3-bosqichda `titleNorm` ustuniga tayanadi —
 * u bo'sh qatorlar faqat 2-bosqich (`title contains`) orqali, transkripsiyasiz
 * topiladi. Ushbu skript barcha qatorlarni `normalizeTitle(title)` ga yangilaydi,
 * shunda kirill/lotin barcha variantlar bir xil natija bera boshlaydi.
 *
 * Ishga tushirish:
 *   npx tsx src/scripts/backfillTitleNorm.ts
 *
 * Xavfsiz: `titleNorm` bo'sh yoki eskirgan (joriy titulga mos kelmaydigan)
 * qatorlar yangilanadi; to'g'ri qiymatga ega qatorlar tegishilmaydi. Idempotent.
 */
import { prisma } from "../prisma.js";
import { normalizeTitle } from "../utils/translit.js";

async function main() {
  let moviesUpdated = 0,
    serialsUpdated = 0;

  // Movies — titleNorm bo'sh yoki titulga mos kelmaydiganlarini yangilash
  const movies = await prisma.movie.findMany({
    select: { id: true, title: true, titleNorm: true },
  });
  for (const m of movies) {
    const norm = normalizeTitle(m.title);
    if (m.titleNorm !== norm) {
      await prisma.movie.update({ where: { id: m.id }, data: { titleNorm: norm } });
      moviesUpdated++;
    }
  }

  // Serials
  const serials = await prisma.serial.findMany({
    select: { id: true, title: true, titleNorm: true },
  });
  for (const s of serials) {
    const norm = normalizeTitle(s.title);
    if (s.titleNorm !== norm) {
      await prisma.serial.update({ where: { id: s.id }, data: { titleNorm: norm } });
      serialsUpdated++;
    }
  }

  console.log(
    `✅ Backfill yakunlandi: ${moviesUpdated} kino, ${serialsUpdated} serial yangilandi.`
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("❌ Backfill xatosi:", err);
  await prisma.$disconnect();
  process.exit(1);
});
