-- ADMIN O'ZI YARATGAN HAVOLA — darvoza tugmasi uchun ustun manba.
--
-- Sabab: bot yaratgan tracking havolalari tashqaridan bekor qilinib turdi
-- (14.08.2026 da beshtala kanalda `is_revoked = true` edi va majburiy obuna
-- jimgina ishlamay qoldi). Egasi o'z havolasini ulab, uni Telegram'ning o'z
-- interfeysida nazorat qilishi va qo'shilish sonini o'sha yerda ko'rishi
-- kerak bo'ldi.
--
-- Nega alohida ustun, `inviteLink` emas: u yerda BOT yaratgan zaxira havolalar
-- ham saqlanadi (PRIVATE/REQUEST kanallarda `processChannelInfo` va
-- `ch:autoinvite` yozadi). Ikkalasini bitta ustunga qo'shsak, darvoza ustunligi
-- o'zgarganda o'sha kanallarning havola-atributsiyasi ham buzilardi.
--
-- Qo'shimcha foyda: `finishAddChannel` ning `upsert.update` qismi `inviteLink`
-- ni qayta yozadi (ommaviy kanalda NULL bilan) — alohida ustun kanal qayta
-- qo'shilganda admin havolasini yo'qotmaydi.

ALTER TABLE "channels" ADD COLUMN "adminInviteLink" TEXT;
