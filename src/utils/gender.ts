/**
 * Ism bo'yicha taxminiy jins aniqlash.
 * MUHIM: Telegram Bot API foydalanuvchi jinsini umuman bermaydi — bu FAQAT
 * ismga qarab taxmin (100% aniq emas). Har doim "taxminiy" deb ko'rsatilsin.
 */

const FEMALE_NAMES = new Set([
  "gulnora",
  "gulnoza",
  "gulbahor",
  "gulchehra",
  "gulmira",
  "gulzoda",
  "gulruh",
  "gulshan",
  "dilnoza",
  "dilorom",
  "dildora",
  "dilfuza",
  "dilbar",
  "dilrabo",
  "dilshoda",
  "malika",
  "madina",
  "mohira",
  "mohinur",
  "mohigul",
  "muxlisa",
  "munisa",
  "mubina",
  "nilufar",
  "nigora",
  "nodira",
  "nasiba",
  "nafisa",
  "nargiza",
  "nargis",
  "sevara",
  "sevinch",
  "shahnoza",
  "shoira",
  "sitora",
  "saodat",
  "sabina",
  "sabrina",
  "zarina",
  "zulfiya",
  "ziyoda",
  "zebo",
  "zamira",
  "feruza",
  "farangiz",
  "fotima",
  "farida",
  "oydin",
  "ozoda",
  "ohunjon",
  "ominaxon",
  "amina",
  "aziza",
  "asal",
  "anora",
  "kamola",
  "komila",
  "xadicha",
  "xosiyat",
  "xurshida",
  "hulkar",
  "husnora",
  "yulduz",
  "yorqinoy",
  "robiya",
  "rayhon",
  "raushan",
  "ra'no",
  "elena",
  "olga",
  "irina",
  "anna",
  "anastasiya",
  "mariya",
  "ekaterina",
  "svetlana",
  "natalya",
  "tatyana",
  "yuliya",
  "viktoriya",
  "kristina",
  "polina",
  "diana",
  "alina",
  "aliya",
  "kamila",
  "sofiya",
  "vera",
  "nina",
  "lyudmila",
  "larisa",
  "oksana",
]);

const MALE_NAMES = new Set([
  "abdulla",
  "akmal",
  "alisher",
  "anvar",
  "aziz",
  "bekzod",
  "bobur",
  "botir",
  "davron",
  "dilshod",
  "diyor",
  "elyor",
  "erkin",
  "farrux",
  "farhod",
  "furqat",
  "gayrat",
  "islom",
  "jasur",
  "javohir",
  "jahongir",
  "kamol",
  "komil",
  "laziz",
  "mansur",
  "mirjalol",
  "muhammad",
  "murod",
  "nodir",
  "nuriddin",
  "ortiq",
  "otabek",
  "rustam",
  "ravshan",
  "sardor",
  "sanjar",
  "sherzod",
  "shavkat",
  "temur",
  "tohir",
  "ulugbek",
  "umid",
  "utkir",
  "xasan",
  "xurshid",
  "yusuf",
  "zafar",
  "ziyodulla",
  "rustambek",
  "islombek",
  "jasurbek",
  "sardorbek",
  "aleksandr",
  "sergey",
  "andrey",
  "dmitriy",
  "mixail",
  "ivan",
  "nikolay",
  "vladimir",
  "aleksey",
  "pavel",
  "roman",
  "denis",
  "artyom",
  "maksim",
  "egor",
]);

const FEMALE_SUFFIXES = ["oy", "gul", "niso", "xon", "moh", "jamol", "posha"];
const MALE_SUFFIXES = ["bek", "jon", "mirzo", "xo'ja", "ullo", "sher", "yor"];

export type Gender = "erkak" | "ayol" | "noaniq";

/** Ism bo'yicha taxminiy jinsni qaytaradi. Aniq emas — faqat statistik taxmin. */
export function guessGender(firstName: string | null | undefined): Gender {
  if (!firstName) return "noaniq";
  const name = firstName.trim().toLowerCase().split(/\s+/)[0];
  if (!name) return "noaniq";

  if (FEMALE_NAMES.has(name)) return "ayol";
  if (MALE_NAMES.has(name)) return "erkak";

  for (const suf of FEMALE_SUFFIXES) if (name.endsWith(suf)) return "ayol";
  for (const suf of MALE_SUFFIXES) if (name.endsWith(suf)) return "erkak";

  // Rus tilidagi ayol ismlari ko'pincha "-a"/"-ya" bilan tugaydi (Uzbekcha erkak
  // ismlarida ham uchraydi — shuning uchun faqat kirill/rus harflariga mos so'z
  // uzunligi katta bo'lsa taxmin qilinadi, aks holda noaniq qoldiriladi).
  if (/(a|ya)$/.test(name) && name.length >= 5) return "ayol";

  return "noaniq";
}

export interface GenderBreakdown {
  female: number;
  male: number;
  unknown: number;
}

export function summarizeGender(firstNames: (string | null)[]): GenderBreakdown {
  const result: GenderBreakdown = { female: 0, male: 0, unknown: 0 };
  for (const name of firstNames) {
    const g = guessGender(name);
    if (g === "ayol") result.female++;
    else if (g === "erkak") result.male++;
    else result.unknown++;
  }
  return result;
}
