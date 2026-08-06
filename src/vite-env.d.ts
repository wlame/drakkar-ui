/// <reference types="svelte" />
/// <reference types="vite/client" />

// Build-time constant injected by Vite `define` (see vite.config.ts): the
// release tag (vX.Y.Z) or "dev" for untagged builds.
declare const __APP_VERSION__: string

// monaco-editor ships no type declarations for this side-effect-only
// contribution module — it is imported purely to register the JSON
// language and its worker (see CodeBlock.svelte), not for any exported
// value.
declare module 'monaco-editor/language/json/monaco.contribution'
