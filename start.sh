#!/bin/sh
set -e

echo "=== Prisma migrations ==="
# Eski deploy'lar `db push` ishlatgan — bunday bazada _prisma_migrations jadvali
# yo'q, lekin jadvallar allaqachon bor. Init baseline baza holatiga mos, shuning
# uchun uni "applied" deb belgilaymiz (SQL ishga tushirilmaydi), keyin qolgan
# migration'lar odatdagidek qo'llanadi.
#
# DIQQAT: bu qadam faqat jadvallar AVVALDAN mavjud bazada kerak. Yangi/bo'sh
# bazada init-ni "applied" deb belgilash jadvallarni yaratmasdan o'tkazib yuboradi
# va keyingi ALTER'lar "relation does not exist" bilan buzadi.
# Tekshiruv node bilan (container'da psql yo'q): "users" jadvali bor-yo'qligi.
if node --input-type=commonjs -e "
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  p.\$queryRawUnsafe(\"SELECT to_regclass('users')::text AS t\")
    .then((r) => process.exit(r && r[0] && r[0].t ? 0 : 1))
    .catch((e) => { console.error('Baza tekshiruvi xatosi:', e.message); process.exit(2); });
"; then
  echo "Baza allaqachon jadvallar bilan mavjud — init baseline 'applied' deb belgilanadi."
  npx prisma migrate resolve --applied 20260807000000_init || true
else
  # Faqat 1 = jadval yo'q (haqiqatan bo'sh baza). 2 = tekshiruvning o'zi yiqildi —
  # bunday holatda "bo'sh baza" deb faraz qilish MAVJUD bazada init'ni ishga tushirib
  # "already exists" bilan buzadi, shuning uchun to'xtaymiz.
  rc=$?
  if [ "$rc" != "1" ]; then
    echo "Baza holatini aniqlab bo'lmadi (exit $rc) — migration ishga tushirilmaydi."
    exit 1
  fi
  echo "Yangi/bo'sh baza — init migration oddiy tarzda qo'llanadi."
fi

npx prisma migrate deploy

echo "=== Bot ishga tushmoqda ==="
exec node dist/index.js
