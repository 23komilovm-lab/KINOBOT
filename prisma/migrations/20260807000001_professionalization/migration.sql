-- AlterTable
ALTER TABLE "users" ADD COLUMN     "contentRequestCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "contentRequestDay" TEXT;

-- AlterTable
ALTER TABLE "broadcasts" ADD COLUMN     "processed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'completed',
ADD COLUMN     "total" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "movies" ADD COLUMN     "titleNorm" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "serials" ADD COLUMN     "titleNorm" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "serial_watch" (
    "userId" BIGINT NOT NULL,
    "serialId" INTEGER NOT NULL,
    "episodeId" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "serial_watch_pkey" PRIMARY KEY ("userId","serialId")
);

-- CreateTable
CREATE TABLE "watch_events" (
    "id" SERIAL NOT NULL,
    "userId" BIGINT NOT NULL,
    "movieId" INTEGER,
    "serialId" INTEGER,
    "genre" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watch_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "watch_events_userId_createdAt_idx" ON "watch_events"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "watch_events_genre_idx" ON "watch_events"("genre");

-- CreateIndex
CREATE INDEX "users_premiumUntil_idx" ON "users"("premiumUntil");

-- CreateIndex
CREATE INDEX "users_aiRequestDay_idx" ON "users"("aiRequestDay");

-- CreateIndex
CREATE INDEX "broadcasts_status_idx" ON "broadcasts"("status");

-- CreateIndex
CREATE INDEX "join_requests_userId_idx" ON "join_requests"("userId");

-- CreateIndex
CREATE INDEX "channel_events_date_idx" ON "channel_events"("date");

-- CreateIndex
CREATE INDEX "movies_genre_idx" ON "movies"("genre");

-- CreateIndex
CREATE INDEX "movies_views_idx" ON "movies"("views");

-- CreateIndex
CREATE INDEX "serials_genre_idx" ON "serials"("genre");

-- CreateIndex
CREATE INDEX "serials_views_idx" ON "serials"("views");

-- AddForeignKey
ALTER TABLE "serial_watch" ADD CONSTRAINT "serial_watch_serialId_fkey" FOREIGN KEY ("serialId") REFERENCES "serials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_events" ADD CONSTRAINT "watch_events_movieId_fkey" FOREIGN KEY ("movieId") REFERENCES "movies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_events" ADD CONSTRAINT "watch_events_serialId_fkey" FOREIGN KEY ("serialId") REFERENCES "serials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
