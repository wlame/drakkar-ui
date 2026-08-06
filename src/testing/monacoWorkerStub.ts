// Stand-in for monaco-editor's `?worker` imports under vitest.
//
// Vite's `?worker` suffix is only handled by the dedicated worker plugin
// during `vite build` / `vite dev`; vitest's transform pipeline doesn't run
// it, so the real specifiers (`monaco-editor/esm/vs/editor/editor.worker
// ?worker`, `.../json/json.worker?worker`) fail to resolve there — see the
// `resolve.alias` entries in vite.config.ts that redirect to this file only
// when VITEST is set. Nothing in the test suite actually constructs a
// worker (CodeBlock's Monaco editor only ever gets created in a real
// browser), so a placeholder default export is enough to satisfy the
// import graph that CodeBlock.svelte pulls in wherever it's rendered.
export default class MonacoWorkerStub {}
