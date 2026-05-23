import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
      globals: {
        // Core globals
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        console: "readonly",
        crypto: "readonly",
        React: "readonly",
        // Timers
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        // DOM element types
        Element: "readonly",
        Node: "readonly",
        HTMLElement: "readonly",
        HTMLButtonElement: "readonly",
        HTMLVideoElement: "readonly",
        HTMLDivElement: "readonly",
        HTMLInputElement: "readonly",
        // Browser APIs used in YusafCut
        Event: "readonly",
        CustomEvent: "readonly",
        CSS: "readonly",
        MutationObserver: "readonly",
        ResizeObserver: "readonly",
        DOMException: "readonly",
        MediaError: "readonly",
        // Animation / rendering
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        // DOM element types (extended)
        HTMLSpanElement: "readonly",
        HTMLSelectElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLAnchorElement: "readonly",
        HTMLLabelElement: "readonly",
        // DOM event types
        KeyboardEvent: "readonly",
        MouseEvent: "readonly",
        PointerEvent: "readonly",
        InputEvent: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      react: reactPlugin,
      "react-hooks": reactHooks,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "react/jsx-uses-react": "off",
      "react/react-in-jsx-scope": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
    settings: { react: { version: "detect" } },
  },
  {
    ignores: ["dist/", "src-tauri/", "sidecars/", "node_modules/"],
  },
];
