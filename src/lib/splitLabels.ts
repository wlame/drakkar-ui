// Labels the backend stamps on the tasks of a split job: `split_part` is the
// part number for a part task and `local` for a task of a message that ran in
// place; `split_job` is `<partition>:<offset>` of the source message.

export type SplitTaskKind = 'part' | 'local'

/** Which split look a task gets, from its labels; null for any other task. */
export function splitTaskKind(
  labels: Record<string, string> | null | undefined,
): SplitTaskKind | null {
  const value = labels?.split_part
  if (value === undefined) return null
  if (value === 'local') return 'local'
  return /^\d+$/.test(value) ? 'part' : null
}

const TRACE_LABEL_PREFIX = '#trace-label/'

/** The Trace tab link for a label search; the value is URL-encoded. */
export function traceLabelHash(key: string, value: string): string {
  return `${TRACE_LABEL_PREFIX}${encodeURIComponent(key)}=${encodeURIComponent(value)}`
}

/** Parse a `#trace-label/<key>=<value>` fragment; null when it is not one. */
export function parseTraceLabelHash(fragment: string): { key: string; value: string } | null {
  if (!fragment.startsWith(TRACE_LABEL_PREFIX)) return null
  const rest = fragment.slice(TRACE_LABEL_PREFIX.length)
  const eq = rest.indexOf('=')
  if (eq <= 0) return null
  try {
    const key = decodeURIComponent(rest.slice(0, eq))
    const value = decodeURIComponent(rest.slice(eq + 1))
    return value ? { key, value } : null
  } catch {
    return null
  }
}
