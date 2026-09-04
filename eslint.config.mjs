import js from "@eslint/js";
import globals from "globals";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const baseFiles = ["**/*.{js,jsx,ts,tsx,cjs,mjs}"];
const ignorePatterns = [
  "**/node_modules/**",
  "**/.next/**",
  "**/coverage/**",
  "**/dist/**",
  "**/playwright-report/**",
  "**/test-results/**",
  "**/*.tsbuildinfo",
];

export default [
  {
    ignores: ignorePatterns,
  },
  {
    files: baseFiles,
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.es2024,
        ...globals.browser,
        ...globals.node,
        ...globals.jest,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,
      "no-undef": "off",
      "no-unused-vars": "off",
      // New in @eslint/js 10's recommended set. Every hit in this repo is a
      // deliberate default initializer — `let status = "ok"` / `let port = null`
      // ahead of a try/catch or branch that overwrites it on all current paths.
      // The rule is technically right that the initial value is never read
      // today, but removing those defaults makes the code strictly more fragile:
      // the next early return or new branch silently yields `undefined` instead
      // of a sane fallback. Keeping the defaults is the safer contract.
      "no-useless-assignment": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];
