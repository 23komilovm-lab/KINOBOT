-- Kanal atributsiyasi: bot tracking invite havolalari.
-- `feat: bot tracking invite links for channel attribution` commitida
-- schema.prisma o'zgargan, lekin migration yozilmagan edi — natijada prodda
-- "The column channels.botInviteLink does not exist" xatosi chiqdi.

-- Har bir kanal uchun bot yaratgan tracking havolasi (createChatInviteLink)
ALTER TABLE "channels" ADD COLUMN     "botInviteLink" TEXT;

-- Qo'shilish hodisasi qaysi manbadan kelgani (bot havolasi / boshqa)
ALTER TABLE "channel_events" ADD COLUMN     "source" TEXT DEFAULT 'unknown';

-- Manba kesimidagi statistika so'rovlari uchun
CREATE INDEX "channel_events_channelId_source_idx" ON "channel_events"("channelId", "source");

-- schema.prisma da `updatedAt` @updatedAt bilan boshqariladi (DB default emas).
-- Qiymatni doim Prisma yozadi; broadcasts ga xom SQL INSERT yo'q.
ALTER TABLE "broadcasts" ALTER COLUMN "updatedAt" DROP DEFAULT;
