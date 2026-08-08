// Admin bo'limlari va huquqlar
export const SECTIONS = [
  "stats",
  "channels",
  "movies",
  "serials",
  "broadcast",
  "funnel",
  "referrals",
  "backup",
  "ai",
  "premium",
] as const;

export type Section = (typeof SECTIONS)[number];

export const SECTION_LABELS: Record<Section, string> = {
  stats: "Statistika",
  channels: "Kanal boshqaruvi",
  movies: "Kino boshqaruvi",
  serials: "Serial boshqaruvi",
  broadcast: "Xabar yuborish",
  funnel: "Funnel",
  referrals: "Referal",
  backup: "Backup",
  ai: "AI yordamchi",
  premium: "Premium",
};

/** permissions stringni bo'limlar ro'yxatiga aylantiradi. null/"" = hammasi ruxsat */
export function parsePerms(perms: string | null | undefined): Section[] | null {
  if (perms === null || perms === undefined || perms.trim() === "") return null;
  const arr = perms
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return arr.filter((s): s is Section => (SECTIONS as readonly string[]).includes(s));
}

/** Bo'limlar ro'yxatini stringga aylantiradi */
export function serializePerms(sections: Section[]): string {
  return sections.join(",");
}
