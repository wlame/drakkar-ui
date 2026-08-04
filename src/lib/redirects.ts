// Paths that used to be pages. The partition and sink tables moved onto the
// Dashboard and the partition detail page was removed, so these paths have no
// component. They redirect instead of showing NotFound, because operators
// bookmark them.
//
// Like the route table, this is data: adding a removed path is a row, not a branch.

interface RedirectRule {
  /** Path pattern. A ":param" segment matches exactly one segment. */
  pattern: string
  to: string
}

const RULES: RedirectRule[] = [
  { pattern: '/partitions', to: '/' },
  { pattern: '/partitions/:id', to: '/' },
  { pattern: '/sinks', to: '/' },
]

function normalize(p: string): string {
  return p !== '/' && p.endsWith('/') ? p.slice(0, -1) : p
}

function matches(pattern: string, pathname: string): boolean {
  const pSegs = normalize(pattern).split('/')
  const aSegs = normalize(pathname).split('/')
  if (pSegs.length !== aSegs.length) return false
  return pSegs.every((seg, i) => seg.startsWith(':') || seg === aSegs[i])
}

/** Return the replacement path for a removed route, or null to render normally. */
export function resolveRedirect(pathname: string): string | null {
  const rule = RULES.find((r) => matches(r.pattern, pathname))
  return rule ? rule.to : null
}
