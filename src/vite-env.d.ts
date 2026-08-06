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

// Same as above: these five internal monaco-editor modules are imported
// purely for their `registerSingleton(...)` side effects (see the
// loadMonaco() comment in CodeBlock.svelte for why they must be imported
// ahead of `editor/editor.api`), not for any exported value, and ship no
// type declarations of their own.
declare module 'monaco-editor/editor/contrib/codelens/browser/codeLensCache'
declare module 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsController'
declare module 'monaco-editor/editor/common/services/treeViewsDndService'
declare module 'monaco-editor/editor/contrib/suggest/browser/suggestMemory'
declare module 'monaco-editor/platform/actionWidget/browser/actionWidget'
