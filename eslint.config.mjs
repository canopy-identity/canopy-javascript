import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/src/generated/**",
      "**/node_modules/**",
      "**/coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A published client must not surface `any` to a caller — the types are
      // the product, so weakening them defeats the point of the package.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests assert on loosely-typed fixtures, and the generate script reads an
    // untyped JSON document.
    files: ["**/*.test.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
  {
    // Last, so nothing re-enables type-aware rules for it. These files are not
    // part of the TypeScript project, so the project service cannot type them.
    // They are Node scripts (this config, the release-notes extractor), so the
    // two Node globals they use are declared here; `globals` is only a
    // transitive install, and importing it would be a phantom dependency.
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // Spread first: disableTypeChecked switches the project service off for
      // these files through languageOptions, and a bare object here would
      // replace that and turn it back on.
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { process: "readonly", console: "readonly" },
    },
  },
);
