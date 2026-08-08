/** ESLint 8 — TypeScript loyiha konfiguratsiyasi (Phase 4.1) */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { node: true, es2022: true },
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  ignorePatterns: ["dist/", "node_modules/", "prisma/migrations/"],
  rules: {
    // Faqat premium emoji turidagi maxsus Telegram HTML uchun `any` kerak
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
    ],
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "no-empty": "off",
    // Admin qo'shish oqimlarida `while (true)` — conversation.wait() kiritishni
    // validatsiya qilishning standart usuli (break/return orqali chiqiladi).
    "no-constant-condition": "off",
  },
};
