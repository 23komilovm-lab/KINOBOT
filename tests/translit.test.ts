import { describe, it, expect } from "vitest";
import { latinize, normalizeTitle } from "../src/utils/translit.js";

describe("latinize", () => {
  it("kirill harflarni lotinga o'tkazadi", () => {
    expect(latinize("Бойчечак")).toBe("boychechak");
    expect(latinize("Ассалом")).toBe("assalom");
  });

  it("o'zbek kirill belgilari (ў,ғ,қ,ҳ) to'g'ri", () => {
    // Raw transliteratsiya: ў→o' va ғ→g' (okina fold normalizeTitle'da bo'ladi)
    expect(latinize("ўғил")).toBe("o'g'il");
    expect(latinize("қалб")).toBe("qalb");
    expect(latinize("ҳаёт")).toBe("hayot");
  });

  it("katta harfni kichiklashtiradi", () => {
    expect(latinize("O'zbekiston")).toBe("o'zbekiston");
  });
});

describe("normalizeTitle", () => {
  it("o'/g' okinasini birlashtiradi va tinish belgilarini olib tashlaydi", () => {
    // Apostrofning barcha ko'rinishlari bir xil natijaga kelsin
    expect(normalizeTitle("Bo'ychechak")).toBe("boychechak");
    expect(normalizeTitle("Bo`ychechak")).toBe("boychechak");
    expect(normalizeTitle("Boʻychechak")).toBe("boychechak");
    expect(normalizeTitle("Boychechak")).toBe("boychechak");
  });

  it("kirill va lotin variantlari bir xil norma beradi", () => {
    expect(normalizeTitle("Бойчечак")).toBe("boychechak");
    expect(normalizeTitle("Bo'ychechak")).toBe("boychechak");
  });

  it("orasidagi ortiqcha bo'shliqlarni siqadi", () => {
    expect(normalizeTitle("   Kino   nomi  ")).toBe("kino nomi");
  });

  it("g' variantlari bir xil", () => {
    expect(normalizeTitle("G'ayrat")).toBe("gayrat");
    expect(normalizeTitle("Ғайрат")).toBe("gayrat");
  });

  it("belgilar/raqamlar aralashmasini tozalaydi", () => {
    expect(normalizeTitle("Spider-Man 2!")).toBe("spider man 2");
  });

  it("aksentlangan harflarni asosiy harfga yig'adi (é, è, à, ò)", () => {
    expect(normalizeTitle("Émigré")).toBe("emigre");
    expect(normalizeTitle("À la recherche")).toBe("a la recherche");
    expect(normalizeTitle("Café")).toBe("cafe");
  });

  it("kombinatsiyalovchi diakritiklarni (U+0300/U+0301) olib tashlaydi", () => {
    // e + U+0301 (kombinatsiyalovchi o'tkir urg'u) — precomposed é bilan bir xil norma
    expect(normalizeTitle("émigre")).toBe("emigre");
    expect(normalizeTitle("òc")).toBe("oc");
  });

  it("Turkiy harflarni (Ğ, Ĥ) yig'adi", () => {
    expect(normalizeTitle("Ğandım")).toBe("gandim");
    expect(normalizeTitle("Ĥikmat")).toBe("hikmat");
  });

  it("aksent fold kirill transkripsiyani buzmaydi", () => {
    expect(normalizeTitle("Бойчечак")).toBe("boychechak");
    expect(normalizeTitle("Қўрғонтепа")).toBe("qorgontepa");
  });
});
