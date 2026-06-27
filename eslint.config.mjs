import { defineConfig, globalIgnores } from "eslint/config";

// Toza backend (Express + TypeScript) uchun minimal ESLint konfiguratsiyasi.
// Next.js / React qoidalari olib tashlandi.
const eslintConfig = defineConfig([
  globalIgnores([
    "dist/**",
    "node_modules/**",
  ]),
]);

export default eslintConfig;
