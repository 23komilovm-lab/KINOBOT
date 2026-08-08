/**
 * O'zbekcha transliteratsiya va nom normalizatsiyasi.
 *
 * Maqsad: foydalanuvchi kino/serial nomini QAYSI ALIFBODA yozmasin — kirill
 * ("Бойчечак") yoki lotin ("Bo'ychechak", "boychechak", "Bo`ychechak") —
 * qidiruv bir xil natijani topsin. Barcha variantlar `titleNorm` ustunida
 * yagona lotin ko'rinishga keltiriladi va qidiruv ham shunga solishtiriladi.
 */

/** Kirill → lotin (o'zbekcha + ruscha qo'shimcha belgilar). Kichik harf asos. */
const CYR_TO_LAT: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "j",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "x",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "'",
  ы: "i",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  // O'zbek alifbosiga xos harflar
  ў: "o'",
  ғ: "g'",
  қ: "q",
  ҳ: "h",
  ң: "ng",
};

/** Kirill matnni lotinga o'tkazadi. Katta harflar avval kichiklashtiriladi. */
export function latinize(input: string): string {
  let out = "";
  for (const ch of input.toLowerCase()) {
    out += CYR_TO_LAT[ch] ?? ch;
  }
  return out;
}

// Okina/apostrof belgilarining barcha Unicode variantlari — ular o'zbekcha
// "o'"/"g'" dagi apostrof sifatida yozilishi mumkin.
const OKINA_CHARS = /[ʻʼ‘’`´']/g;

/** O'zbekcha digraf fold: o' → o, g' → g (va bir nechta variantlari). */
function foldUzbek(s: string): string {
  return s
    .replace(/o[ʻʼ‘’`´']/g, "o")
    .replace(/g[ʻʼ‘’`´']/g, "g")
    .replace(OKINA_CHARS, "");
}

/**
 * Chet el kinolaridagi aksentlangan harflarni asosiy harfga yig'adi.
 *
 * NFD normalizatsiyasi precomposed harflarni asos + birlashtiruvchi belgiga
 * ajratadi (é→e+U+0301, ò→o+U+0300, Ğ→G+U+0306, Ĥ→H+U+0302), keyin barcha
 * kombinatsiyalovchi diakritiklarni o'chiramiz. Bu KIRILL MAPPINGDAN KEYIN
 * ishlatilishi shart — aks holda "й"→"и"+U+0306 bo'lib, "y" o'rniga "i" chiqardi.
 */
function foldAccents(s: string): string {
  // NFD bo'lingan qatordagi barcha birlashtiruvchi diakritiklarni (U+0300–U+036F)
  // o'chiramiz. Regex emas, kod nuqtasi filtri — bu yerda ko'rinmas belgilar
  // bilan ishlash xavfsizroq.
  return Array.from(s.normalize("NFD"))
    .filter((ch) => {
      const cp = ch.codePointAt(0)!;
      return cp < 0x0300 || cp > 0x036f;
    })
    .join("");
}

/**
 * NFD orqali ajralmaydigan alohida belgilar — NFD ularni asos + diakritik
 * qilib bo'lmaydi, shuning uchun qo'lda asosiy harfga o'tkaziladi. Eng keng
 * tarqalgani turkcha nuqtasiz "ı" (U+0131) — kino nomlarida uchraydi.
 */
const EXTRA_FOLDS: Record<string, string> = {
  ı: "i", // turkcha nuqtasiz i
  ø: "o",
  ß: "ss",
  æ: "ae",
  ð: "d",
  þ: "th",
  œ: "oe",
  ŧ: "t",
  ł: "l",
};

/**
 * Nomni qidiruv uchun yagona ko'rinishga keltiradi:
 * kichik harf → kirill-lotin → o'/g' fold → aksent fold (NFD) → alohida
 * harflar → tinish/harf bo'lmagan belgilarni bo'sh joyga aylantirish →
 * ortiqcha bo'shliqlarni siqish.
 *
 * "Bo'ychechak", "Бойчечак", "Bo`ychechak" → "boychechak"
 */
export function normalizeTitle(input: string): string {
  return foldAccents(foldUzbek(latinize(input)))
    .replace(/[ıøßæðþœŧł]/g, (ch) => EXTRA_FOLDS[ch] ?? ch)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
