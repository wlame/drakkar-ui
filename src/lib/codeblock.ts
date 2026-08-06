// Pure helpers behind CodeBlock (../components/CodeBlock.svelte): language
// sniffing, the multiline/plain-row threshold, and zebra-stripe line numbers.
// Kept framework-free so the heuristics are unit-testable without mounting
// Svelte or Monaco.

export type CodeLanguage = 'json' | 'drakkar-log' | 'plaintext'

// A line reads as "log-shaped" when it opens with an ISO/RFC3339-ish
// timestamp, carries a structlog-style `level=info` key/value pair, or has a
// bare log-level word (ERROR/WARN/INFO/DEBUG, case-insensitive) on its own.
const TIMESTAMP_RE = /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/
const LEVEL_KV_RE = /\blevel\s*=\s*['"]?(error|warn(?:ing)?|info|debug)['"]?/i
const LEVEL_TOKEN_RE = /\b(ERROR|WARN(?:ING)?|INFO|DEBUG)\b/i

// detectLanguage guesses how `text` should be highlighted. JSON wins first
// (only when the trimmed text both looks like JSON — starts with `{`, `[`, or
// `"` — and actually parses, so a truncated or corrupted payload falls
// through instead of masquerading as JSON). Otherwise any line that looks
// like a log record routes to the 'drakkar-log' Monarch grammar; anything
// else is plaintext.
export function detectLanguage(text: string): CodeLanguage {
  const trimmed = text.trim()
  if (trimmed && /^[{["]/.test(trimmed)) {
    try {
      JSON.parse(trimmed)
      return 'json'
    } catch {
      // Not valid JSON despite the leading brace/bracket/quote — fall
      // through to the log/plaintext checks below.
    }
  }
  const lines = trimmed.split('\n')
  const looksLikeLog = lines.some(
    (line) => TIMESTAMP_RE.test(line) || LEVEL_KV_RE.test(line) || LEVEL_TOKEN_RE.test(line),
  )
  return looksLikeLog ? 'drakkar-log' : 'plaintext'
}

// isMultiline decides between the plain single-line row and the full Monaco
// editor: true once the text wraps a line, or once it is long enough that a
// single unbroken line would blow out the layout anyway.
export function isMultiline(text: string, charThreshold = 160): boolean {
  return text.includes('\n') || text.length > charThreshold
}

// oddLineNumbers returns the 1-based line numbers that get the zebra-stripe
// decoration: [1, 3, 5, ...] up to lineCount.
export function oddLineNumbers(lineCount: number): number[] {
  const result: number[] = []
  for (let line = 1; line <= lineCount; line += 2) result.push(line)
  return result
}
