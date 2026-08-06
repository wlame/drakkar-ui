<script module lang="ts">
  // Shared viewer for big/multiline text: task stdin/stdout/stderr, JSON
  // payloads, tracebacks, cache values. Every instance gets a copy button and
  // zebra striping per LOGICAL line (a long wrapped line is one stripe, not
  // one per wrapped row — that's the point of decorating whole *model* lines
  // instead of CSS nth-child on rendered rows).
  //
  // Monaco is heavy, so it is never in the entry bundle: it is dynamically
  // imported on first mount of any multiline CodeBlock, behind a
  // module-scoped singleton promise (this `<script module>` block runs once
  // per page, not once per instance) so N blocks on one page share a single
  // load. Until it resolves (or if it never does), the plain `.block` row
  // below renders the text directly — content is never invisible while
  // Monaco loads.
  //
  // Importing the bare `monaco-editor` package pulls in its full barrel
  // (esm/vs/index.js), which eagerly registers ~80 built-in languages —
  // including full TypeScript, CSS and HTML language services and their own
  // multi-megabyte workers — none of which this component uses. Importing
  // `editor/editor.api` (the core standalone editor, no language
  // contributions) plus `language/json/monaco.contribution` (JSON support
  // and its worker wiring) keeps the lazy chunk to what's actually used:
  // JSON highlighting plus the hand-rolled 'drakkar-log' Monarch grammar
  // registered below.
  import type * as Monaco from 'monaco-editor/editor/editor.api'

  // Vite's `?worker` suffix compiles each of these into a small lazy Worker
  // constructor (see vite/client's `declare module '*?worker'`), not the
  // worker's own code — so this static import costs only a couple of wrapper
  // functions in whatever chunk CodeBlock.svelte lands in, not monaco-editor
  // itself. Monaco reads `self.MonacoEnvironment` lazily, the first time a
  // language service actually needs a worker, so wiring it up here — before
  // monaco-editor is ever imported — is the standard vite+monaco recipe.
  import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
  import JsonWorker from 'monaco-editor/language/json/json.worker?worker'

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === 'json') return new JsonWorker()
      return new EditorWorker()
    },
  }

  let monacoModulePromise: Promise<typeof Monaco> | null = null
  let logLanguageRegistered = false
  let loadFailureWarned = false

  // Log lines look like:
  //   2024-01-02T03:04:05.678Z level=info msg="task started" duration=1.2
  // Tokens: an ISO/RFC3339 timestamp, a bare or key=value log level, quoted
  // strings, structlog-style `key=` attribute names, and bare numbers.
  function registerLogLanguage(monaco: typeof Monaco) {
    monaco.languages.register({ id: 'drakkar-log' })
    monaco.languages.setMonarchTokensProvider('drakkar-log', {
      ignoreCase: true,
      tokenizer: {
        root: [
          [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/, 'number.date'],
          [/\b(error|warn(?:ing)?|info|debug)\b/, 'keyword'],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/'([^'\\]|\\.)*'/, 'string'],
          [/[A-Za-z_][\w.]*(?==)/, 'attribute.name'],
          [/\b\d+(\.\d+)?\b/, 'number'],
        ],
      },
    })
    logLanguageRegistered = true
  }

  function loadMonaco(): Promise<typeof Monaco> {
    if (!monacoModulePromise) {
      monacoModulePromise = Promise.all([
        import('monaco-editor/editor/editor.api'),
        import('monaco-editor/language/json/monaco.contribution'),
      ]).then(([core]) => {
        if (!logLanguageRegistered) registerLogLanguage(core)
        return core
      })
    }
    return monacoModulePromise
  }
</script>

<script lang="ts">
  import { onDestroy } from 'svelte'
  import { detectLanguage, isMultiline, oddLineNumbers, type CodeLanguage } from '../lib/codeblock'
  import { copyText } from '../lib/copy'

  let {
    text,
    language,
    error = false,
    maxHeight = '18rem',
  }: {
    text: string
    language?: CodeLanguage
    error?: boolean
    maxHeight?: string
  } = $props()

  const resolvedLanguage = $derived(language ?? detectLanguage(text))
  const multiline = $derived(isMultiline(text))

  // --- Copy button -----------------------------------------------------
  let copyState = $state<'idle' | 'copied' | 'failed'>('idle')
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  async function onCopy() {
    const ok = await copyText(text)
    copyState = ok ? 'copied' : 'failed'
    clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(() => (copyState = 'idle'), 1500)
  }

  const copyLabel = $derived(
    copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy',
  )

  onDestroy(() => clearTimeout(copyResetTimer))

  // --- Monaco lifecycle --------------------------------------------------
  let containerEl = $state<HTMLDivElement | undefined>()
  let monacoRef: typeof Monaco | undefined
  let editor: Monaco.editor.IStandaloneCodeEditor | undefined
  let decorations: Monaco.editor.IEditorDecorationsCollection | undefined
  let errorDecorations: Monaco.editor.IEditorDecorationsCollection | undefined
  let editorState = $state<'idle' | 'loading' | 'ready' | 'failed'>('idle')

  function applyZebra() {
    if (!monacoRef || !editor) return
    const model = editor.getModel()
    if (!model) return
    const ranges: Monaco.editor.IModelDeltaDecoration[] = oddLineNumbers(model.getLineCount()).map(
      (line) => ({
        range: new monacoRef!.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: 'cb-zebra' },
      }),
    )
    if (!decorations) decorations = editor.createDecorationsCollection(ranges)
    else decorations.set(ranges)
  }

  // Monaco's syntax colors come from `mtk*` classes on the token spans
  // themselves, so the container's `.cb.error` border alone never reaches
  // the text — the plain-pre fallback's `color: var(--error)` has nothing
  // to apply to once Monaco takes over. `inlineClassName` (not the
  // whole-line `className` zebra uses, which only affects the line's
  // background) decorates the token spans directly; `!important` in the
  // stylesheet beats the `mtk*` rules regardless of which one is later in
  // the cascade or whether Monaco merges the class onto the same span or a
  // nested one — verified against a real render in the Playwright smoke
  // harness before settling on this over the whole-line className.
  function applyErrorTint() {
    if (!monacoRef || !editor) return
    const model = editor.getModel()
    if (!model) return
    if (!error) {
      errorDecorations?.clear()
      return
    }
    const lastLine = model.getLineCount()
    const ranges: Monaco.editor.IModelDeltaDecoration[] = [
      {
        range: new monacoRef.Range(1, 1, lastLine, model.getLineMaxColumn(lastLine)),
        options: { isWholeLine: true, inlineClassName: 'cb-error-text' },
      },
    ]
    if (!errorDecorations) errorDecorations = editor.createDecorationsCollection(ranges)
    else errorDecorations.set(ranges)
  }

  // Container height = min(content height, the maxHeight prop): read the
  // prop's resolved pixel value off the container's own computed style (it
  // carries `max-height: {maxHeight}` in the markup below) so any CSS unit
  // works, then cap the editor's actual content height against it. Beyond
  // that cap the editor scrolls internally.
  function updateHeight() {
    if (!containerEl || !editor) return
    const capPx = parseFloat(getComputedStyle(containerEl).maxHeight)
    const contentPx = editor.getContentHeight()
    const nextPx = Number.isFinite(capPx) ? Math.min(contentPx, capPx) : contentPx
    containerEl.style.height = `${nextPx}px`
    editor.layout()
  }

  // Creates (or tears down) the Monaco instance. Keyed on `multiline` and
  // `containerEl` only — content updates are handled by the effect below —
  // so flipping a short text to a long one (or back) is the only thing that
  // recreates the editor.
  $effect(() => {
    if (!multiline || !containerEl) return
    const container = containerEl
    let cancelled = false
    let resizeObserver: ResizeObserver | undefined
    editorState = 'loading'

    loadMonaco()
      .then((monaco) => {
        if (cancelled) return
        monacoRef = monaco
        const fontFamily = getComputedStyle(container).getPropertyValue('--mono').trim() || 'monospace'
        editor = monaco.editor.create(container, {
          value: text,
          language: resolvedLanguage,
          readOnly: true,
          domReadOnly: true,
          wordWrap: 'on',
          minimap: { enabled: false },
          lineNumbers: 'on',
          folding: resolvedLanguage === 'json',
          scrollBeyondLastLine: false,
          renderLineHighlight: 'none',
          fontSize: 12,
          fontFamily,
          // Without this the whole page can't scroll past the editor — the
          // editor would eat every wheel event even once its own content is
          // fully scrolled.
          scrollbar: { alwaysConsumeMouseWheel: false },
          contextmenu: false,
          links: false,
          occurrencesHighlight: 'off',
          selectionHighlight: false,
          // automaticLayout polls on an interval; a ResizeObserver (wired up
          // below) reacts to actual size changes instead.
          automaticLayout: false,
        })
        applyZebra()
        applyErrorTint()
        updateHeight()
        editor.onDidContentSizeChange(updateHeight)
        resizeObserver = new ResizeObserver(() => editor?.layout())
        resizeObserver.observe(container)
        editorState = 'ready'
      })
      .catch((err: unknown) => {
        if (cancelled) return
        editorState = 'failed'
        if (!loadFailureWarned) {
          loadFailureWarned = true
          console.warn('CodeBlock: failed to load the Monaco editor; staying on plain text.', err)
        }
      })

    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      editor?.dispose()
      editor = undefined
      decorations = undefined
      errorDecorations = undefined
      monacoRef = undefined
      editorState = 'idle'
    }
  })

  // Keeps an already-created editor's content, language, folding, zebra
  // stripes and error tint in sync when the relevant props change, without
  // recreating the editor.
  $effect(() => {
    const nextText = text
    const nextLanguage = resolvedLanguage
    if (!editor || !monacoRef) return
    if (editor.getValue() !== nextText) editor.setValue(nextText)
    const model = editor.getModel()
    if (model && model.getLanguageId() !== nextLanguage) {
      monacoRef.editor.setModelLanguage(model, nextLanguage)
    }
    editor.updateOptions({ folding: nextLanguage === 'json' })
    applyZebra()
    // Reads the `error` prop directly, so this effect also re-runs when
    // `error` changes on its own (without `text`/`language` changing).
    applyErrorTint()
    updateHeight()
  })
</script>

<div class="cb" class:error>
  <div class="cb-header">
    <button
      type="button"
      class="cb-copy"
      class:copied={copyState === 'copied'}
      class:failed={copyState === 'failed'}
      onclick={onCopy}
    >
      {copyLabel}
    </button>
  </div>

  {#if multiline}
    <!-- While Monaco is loading (or fails to), this container sits absolutely
         positioned and invisible instead of `display: none`: Monaco still
         needs a container with a real, measurable width to compute its
         word-wrap column, and `display: none` collapses that to zero. Taking
         it out of flow with `position: absolute` (rather than just
         `visibility: hidden`) keeps it from reserving layout space next to
         the fallback <pre> that's visible during the same window. -->
    <div
      class="cb-monaco-container"
      class:cb-offscreen={editorState !== 'ready'}
      bind:this={containerEl}
      style:max-height={maxHeight}
    ></div>
    {#if editorState !== 'ready'}
      <pre class="block" style:max-height={maxHeight}>{text}</pre>
    {/if}
  {:else}
    <pre class="block" style:max-height={maxHeight}>{text}</pre>
  {/if}
</div>

<style>
  .cb {
    position: relative;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    overflow: hidden;
  }
  .cb.error {
    border-color: var(--error);
  }
  .cb-header {
    display: flex;
    justify-content: flex-end;
    padding: 0.25rem 0.4rem;
    border-bottom: 1px solid var(--line);
    background: var(--panel-2);
  }
  .cb-copy {
    font-size: 0.72rem;
    padding: 0.1rem 0.55rem;
    border-radius: 999px;
    color: var(--muted);
  }
  .cb-copy.copied {
    color: var(--accent);
    border-color: var(--accent);
  }
  .cb-copy.failed {
    color: var(--error);
    border-color: var(--error);
  }
  .cb-monaco-container {
    width: 100%;
  }
  .cb-monaco-container.cb-offscreen {
    position: absolute;
    inset: 0;
    visibility: hidden;
    pointer-events: none;
  }
  .block {
    margin: 0;
    padding: 0.6rem;
    overflow: auto;
    font-family: var(--mono);
    font-size: 0.78rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .cb.error .block {
    color: var(--error);
  }
  /* Whole-line decoration applied to every odd model line — a wrapped
     logical line stays one stripe because it is one Monaco line, not one
     rendered row. */
  :global(.cb-zebra) {
    background: rgba(0, 0, 0, 0.035);
  }
  /* Overrides Monaco's per-token `mtk*` syntax-color classes so error text
     (stderr, tracebacks) still reads as red once Monaco takes over from the
     plain-pre fallback — the `!important` is load-bearing, see
     applyErrorTint()'s comment. */
  :global(.cb-error-text) {
    color: var(--error) !important;
  }
</style>
