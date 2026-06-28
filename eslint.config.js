// ESLint flat config. Layers: core JS recommended → typescript-eslint
// recommended (type-agnostic) → eslint-plugin-svelte recommended, then the two
// prettier presets switch every stylistic rule off — formatting is prettier's
// job (`bun run format`), eslint only judges code quality.
import js from '@eslint/js'
import ts from 'typescript-eslint'
import svelte from 'eslint-plugin-svelte'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import svelteConfig from './svelte.config.js'

export default ts.config(
  // Everything outside the app source: build output, vendored reference code,
  // agent working dirs. eslint.config.js itself stays linted.
  {
    ignores: ['dist/', 'node_modules/', 'pydrakkar/', '.claude/', '.playwright-mcp/'],
  },

  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,

  {
    languageOptions: {
      globals: {
        ...globals.browser,
        // Build-time constant injected by Vite `define` (see vite.config.ts).
        __APP_VERSION__: 'readonly',
      },
    },
  },

  // Svelte <script lang="ts"> blocks are parsed with the TS parser; passing
  // svelte.config.js lets the plugin honor the project's preprocessor setup.
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: ts.parser,
        extraFileExtensions: ['.svelte'],
        svelteConfig,
      },
    },
  },

  {
    rules: {
      // Live/Debug tables render replace-the-whole-list collections where
      // index identity is correct and keyless {#each} is the codebase's
      // established style; keys are still used where rows are stable
      // (Timeline, ResultsTab already pass them).
      'svelte/require-each-key': 'off',
      // Every Map/Set here is either a local scratch collection inside
      // $derived.by/async work or the immutable replace-not-mutate pattern
      // (`const next = new Set(cur); …; cur = next`), which Svelte 5 tracks
      // fine. SvelteMap/SvelteSet are for mutated-in-place reactive state,
      // which this codebase deliberately avoids.
      'svelte/prefer-svelte-reactivity': 'off',
      // `_`-prefixed bindings mark intentionally unused values (pages that
      // take no route params destructure `params` as `_params`; each-blocks
      // use `_` for ignored items).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
)
