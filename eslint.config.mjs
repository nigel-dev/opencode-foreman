import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Destructuring a property away to drop it from the rest is deliberate.
  { rules: { "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }] } },
);
