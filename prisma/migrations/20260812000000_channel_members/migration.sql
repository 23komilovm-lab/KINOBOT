-- Kanal a'zoligi snapshot jadvali + tarixiy backfill.
-- Har (kanal, foydalanuvchi) uchun JORIY a'zolik faktini saqlaydi. `@@unique`
-- prisma darajasidagi dublikat-qo'shilish serializatsiya nuqtasi: ikkita parallel
-- yozuvchi (chat_member ↔ sub:check) Postgres `ON CONFLICT` da bloklanadi va ikkinchi
-- yozuvchi birinchi yozuvni yangilaydi — ikki marta sanash yo'qoladi.

CREATE TABLE "channel_members" (
  "id" SERIAL PRIMARY KEY,
  "channelId" BIGINT NOT NULL,
  "userId" BIGINT NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL DEFAULT 'unknown',
  "leftAt" TIMESTAMP(3),
  CONSTRAINT "channel_members_channelId_userId_key" UNIQUE ("channelId", "userId"),
  CONSTRAINT "channel_members_channelId_fkey" FOREIGN KEY ("channelId")
    REFERENCES "channels"("chatId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "channel_members_channelId_source_joinedAt_idx"
  ON "channel_members"("channelId", "source", "joinedAt");

-- ---- Bazadan backfill: har (kanal,user) uchun eng so'nggi qo'shilish. ----
-- source: biron join 'bot' bo'lsa → 'bot' (bot pasaytirilmaydi), aks holda eng
-- so'nggi join source. leftAt: shu join'dan keyingi birinchi chiqish (yoki NULL
-- = hozir a'zo). Idempotent: ON CONFLICT DO NOTHING.
INSERT INTO "channel_members" ("channelId", "userId", "joinedAt", "source", "leftAt")
SELECT
  je."channelId", je."userId", je."date",
  CASE WHEN EXISTS (SELECT 1 FROM "channel_events" jb
        WHERE jb."channelId" = je."channelId" AND jb."userId" = je."userId"
          AND jb."type" = 'join' AND jb."source" = 'bot')
       THEN 'bot' ELSE COALESCE(je."source", 'unknown') END,
  (SELECT MIN(le."date") FROM "channel_events" le
     WHERE le."channelId" = je."channelId" AND le."userId" = je."userId"
       AND le."type" = 'leave' AND le."date" > je."date")
FROM "channel_events" je
WHERE je."type" = 'join'
  -- FAQAT hozir mavjud kanallar. `channel_events` da FK yo'q, shuning uchun
  -- paneldan o'chirilgan kanallarning yozuvlari bazada qolib ketgan (prodda
  -- 47399 yozuvdan 42936 tasi 13 ta o'chirilgan kanalniki edi). Ularni
  -- qo'shishga urinish FK'ni buzadi va butun migratsiyani yiqitadi
  -- (xato 23503 — 2026-08-12 da aynan shu bo'ldi).
  AND EXISTS (SELECT 1 FROM "channels" c WHERE c."chatId" = je."channelId")
  AND NOT EXISTS (SELECT 1 FROM "channel_events" je2
      WHERE je2."channelId" = je."channelId" AND je2."userId" = je."userId"
        AND je2."type" = 'join'
        AND (je2."date" > je."date" OR (je2."date" = je."date" AND je2."id" > je."id")))
ON CONFLICT ("channelId", "userId") DO NOTHING;