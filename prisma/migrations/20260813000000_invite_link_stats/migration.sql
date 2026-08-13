-- HAVOLA KESIMIDAGI STATISTIKA + KANAL UZIB-ULANGANDA TARIXNI SAQLASH.
--
-- 1-muammo: havola yangilansa eski va yangi havola orqali kelganlar bir qopga
--   tushardi — endi har bir qo'shilish/zayifka QAYSI havola bilan kelgani
--   yoziladi, havolalar tarixi esa alohida jadvalda saqlanadi.
--
-- 2-muammo: kanal paneldan o'chirilganda `ON DELETE CASCADE` zayifkalarni,
--   a'zolik snapshotini va havolalar registrini o'chirib yuborardi, lekin
--   `channel_events` (FK'siz) tirik qolardi. Kanal qayta qo'shilsa statistika
--   yolg'on ko'rsatardi. 13.08.2026 prod holati:
--     Русский язык — tarixda 832 yagona odam, snapshotda 8
--     Kino vaqti   — tarixda 12160,             snapshotda 1546
--     Guruh 2k     — tarixda 34,                snapshotda 0
--   Yechim: FK'larni olib tashlaymiz (hamma tarix `chatId` bo'yicha bog'lanadi
--   va kanaldan omon qoladi) + snapshotni hodisalar jurnalidan tiklaymiz.

-- ---- 1. Havolalar tarixi (FK YO'Q — kanal o'chirilsa ham qolishi kerak) ----
CREATE TABLE "channel_invite_links" (
  "id" SERIAL PRIMARY KEY,
  "channelId" BIGINT NOT NULL,
  "link" TEXT NOT NULL,
  "seq" INTEGER NOT NULL DEFAULT 1,
  "name" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "isCurrent" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "channel_invite_links_link_key" UNIQUE ("link")
);

CREATE INDEX "channel_invite_links_channelId_seq_idx"
  ON "channel_invite_links"("channelId", "seq");

-- ---- 2. Hodisalarga havola ustuni ----
ALTER TABLE "channel_events" ADD COLUMN "inviteLink" TEXT;
ALTER TABLE "channel_members" ADD COLUMN "inviteLink" TEXT;
ALTER TABLE "join_requests" ADD COLUMN "inviteLink" TEXT;

CREATE INDEX "channel_events_channelId_inviteLink_idx"
  ON "channel_events"("channelId", "inviteLink");
CREATE INDEX "channel_members_channelId_inviteLink_idx"
  ON "channel_members"("channelId", "inviteLink");
CREATE INDEX "join_requests_channelId_inviteLink_idx"
  ON "join_requests"("channelId", "inviteLink");

-- ---- 3. Cascade FK'larni olib tashlash ----
-- Shundan keyin kanalni o'chirish tarixni O'CHIRMAYDI. Yetim yozuvlar
-- to'planishi mumkin (channel_events allaqachon shunday ishlaydi), lekin
-- o'sha chatId qayta qo'shilsa tarix avtomatik ulanadi.
ALTER TABLE "channel_members" DROP CONSTRAINT IF EXISTS "channel_members_channelId_fkey";
ALTER TABLE "join_requests"   DROP CONSTRAINT IF EXISTS "join_requests_channelId_fkey";

-- ---- 4. Mavjud havolalarni registrga ko'chirish ----
-- `channels.botInviteLink` — joriy tracking havolasi (#1),
-- `channels.inviteLink`  — majburiy obuna uchun zaxira havolasi.
-- INSTAGRAM kanalning `inviteLink` i profil URL'i — u havola emas, tashlab
-- ketiladi. `createdAt` aniq ma'lum emas, shuning uchun kanal qo'shilgan sana
-- olinadi (quyi chegara).
--
-- DIQQAT: eski `channel_events` yozuvlarida `inviteLink` NULL — ular havolaga
-- taqsimlanmaydi va panelda "havola aniqlanmagan" qatorida ko'rinadi. Sun'iy
-- taqsimlash statistikani yolg'onlashtirardi.
INSERT INTO "channel_invite_links" ("channelId", "link", "seq", "name", "createdAt", "isCurrent")
SELECT
  x."chatId",
  x."link",
  ROW_NUMBER() OVER (PARTITION BY x."chatId" ORDER BY x."ord"),
  x."name",
  x."createdAt",
  x."isCurrent"
FROM (
  SELECT c."chatId", c."botInviteLink" AS "link", 1 AS "ord",
         'bot_tracking' AS "name", c."createdAt", true AS "isCurrent"
    FROM "channels" c
   WHERE c."botInviteLink" IS NOT NULL
  UNION ALL
  SELECT c."chatId", c."inviteLink", 2,
         'majburiy_obuna', c."createdAt", true
    FROM "channels" c
   WHERE c."inviteLink" IS NOT NULL
     AND c."type" <> 'INSTAGRAM'
     AND (c."botInviteLink" IS NULL OR c."inviteLink" <> c."botInviteLink")
) x
ON CONFLICT ("link") DO NOTHING;

-- ---- 5. A'zolik snapshotini hodisalar jurnalidan TIKLASH ----
-- 20260812 dagi backfill faqat o'sha lahzada mavjud kanallar uchun ishlagan.
-- Kanallar undan KEYIN (qayta) qo'shilgani uchun ularning tarixi ko'chmay
-- qolgan. Shu so'rov aynan o'sha mantiq, lekin idempotent: allaqachon bor
-- (kanal, foydalanuvchi) juftliklari tegilmaydi.
INSERT INTO "channel_members" ("channelId", "userId", "joinedAt", "source", "inviteLink", "leftAt")
SELECT
  je."channelId", je."userId", je."date",
  CASE WHEN EXISTS (SELECT 1 FROM "channel_events" jb
        WHERE jb."channelId" = je."channelId" AND jb."userId" = je."userId"
          AND jb."type" = 'join' AND jb."source" = 'bot')
       THEN 'bot' ELSE COALESCE(je."source", 'unknown') END,
  je."inviteLink",
  (SELECT MIN(le."date") FROM "channel_events" le
     WHERE le."channelId" = je."channelId" AND le."userId" = je."userId"
       AND le."type" = 'leave' AND le."date" > je."date")
FROM "channel_events" je
WHERE je."type" = 'join'
  -- Faqat hozir mavjud kanallar: o'chirilganlarniki uchun snapshot ma'nosiz
  -- (panelda ko'rinmaydi). Ular qayta qo'shilsa `rebuildMemberSnapshot`
  -- ishga tushadi — channels.ts dagi qo'shish oqimida.
  AND EXISTS (SELECT 1 FROM "channels" c WHERE c."chatId" = je."channelId")
  -- Har (kanal,user) uchun eng so'nggi qo'shilish
  AND NOT EXISTS (SELECT 1 FROM "channel_events" je2
      WHERE je2."channelId" = je."channelId" AND je2."userId" = je."userId"
        AND je2."type" = 'join'
        AND (je2."date" > je."date" OR (je2."date" = je."date" AND je2."id" > je."id")))
ON CONFLICT ("channelId", "userId") DO NOTHING;
