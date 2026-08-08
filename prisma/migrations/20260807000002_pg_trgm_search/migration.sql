-- pg_trgm extension + GIN indekslar — aqlli qidiruv uchun.
-- schema.prisma da ifodalab bo'lmaydi (raw SQL talab qiladi), shuning uchun
-- qo'lda yozilgan migration. B-tree (movies.title_idx) `%q%` LIKE uchun
-- foydasiz — trgm GIN indeksi leading-wildcard qidiruvni indekslaydi.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Asl title (case-insensitive)
CREATE INDEX IF NOT EXISTS movies_title_trgm_idx
  ON "movies" USING gin (lower("title") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS serials_title_trgm_idx
  ON "serials" USING gin (lower("title") gin_trgm_ops);

-- Normalizatsiya qilingan titleNorm (lotin, kichik, tinishsiz)
CREATE INDEX IF NOT EXISTS movies_title_norm_trgm_idx
  ON "movies" USING gin (lower("titleNorm") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS serials_title_norm_trgm_idx
  ON "serials" USING gin (lower("titleNorm") gin_trgm_ops);
