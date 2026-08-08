/**
 * O'zbekiston viloyatlari — standart so'rovnoma variantlari uchun.
 * Koordinatalar — har hudud markazi (taxminiy, viloyat markazi shahri) —
 * "eng yaqin markaz" evristikasi bilan GPS orqali hudud aniqlash uchun.
 * Aniqlik: chegara-aniq emas, shahar markaziga eng yaqinini tanlaydi — odatda yetarli.
 */
export const UZ_REGIONS: { name: string; lat: number; lon: number }[] = [
  { name: "Toshkent shahri", lat: 41.2995, lon: 69.2401 },
  { name: "Toshkent viloyati", lat: 41.4687, lon: 69.5809 },
  { name: "Andijon viloyati", lat: 40.7821, lon: 72.3442 },
  { name: "Buxoro viloyati", lat: 39.7747, lon: 64.4286 },
  { name: "Farg'ona viloyati", lat: 40.3864, lon: 71.7864 },
  { name: "Jizzax viloyati", lat: 40.1158, lon: 67.8422 },
  { name: "Xorazm viloyati", lat: 41.5506, lon: 60.6317 },
  { name: "Namangan viloyati", lat: 40.9983, lon: 71.6726 },
  { name: "Navoiy viloyati", lat: 40.0844, lon: 65.3792 },
  { name: "Qashqadaryo viloyati", lat: 38.8606, lon: 65.7891 },
  { name: "Qoraqalpog'iston Respublikasi", lat: 42.4531, lon: 59.6103 },
  { name: "Samarqand viloyati", lat: 39.6542, lon: 66.9597 },
  { name: "Sirdaryo viloyati", lat: 40.4897, lon: 68.7842 },
  { name: "Surxondaryo viloyati", lat: 37.2242, lon: 67.2783 },
];

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** GPS koordinataga eng yaqin viloyat nomini qaytaradi (taxminiy) */
export function nearestRegion(lat: number, lon: number): string {
  let best = UZ_REGIONS[0];
  let bestDist = Infinity;
  for (const r of UZ_REGIONS) {
    const d = haversineKm(lat, lon, r.lat, r.lon);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best.name;
}
