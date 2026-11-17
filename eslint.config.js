import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.config.*", "**/openapi/**", "**/coverage/**", "**/playwright-report/**", "**/test-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }] } },
  // Plain-JS e2e scripts mix Node globals and browser code run via page.evaluate; TypeScript checks undefined names in .ts files.
  { files: ["**/*.mjs"], rules: { "no-undef": "off" } }
);
