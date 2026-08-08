import type { Component } from 'svelte'
import Dashboard from '../pages/Dashboard.svelte'
import TaskDetail from '../pages/TaskDetail.svelte'
import History from '../pages/History.svelte'
import Live from '../pages/Live.svelte'
import Debug from '../pages/Debug.svelte'
import UserPage from '../pages/UserPage.svelte'
import NotFound from '../pages/NotFound.svelte'

// The route table is data, not control flow: each row maps a path *pattern* to a
// page component. Patterns may contain dynamic `:param` segments (e.g.
// "/task/:id"); resolve() matches segment-by-segment and extracts the params.
// Adding a page = add a component in src/pages/ + a row here. The router itself
// has no per-route branching.
// Every page receives its matched route params as an optional prop, so the route
// table is typed against that shared shape.
export type PageComponent = Component<{ params?: Record<string, string> }>

export interface Route {
  path: string
  component: PageComponent
}

// navItems drives the header nav. It is intentionally separate from the route
// table so the full ops-console chrome (all four top-level pages) is present even
// while individual pages are still being built out — and so a detail route like
// /task/:id never appears as a nav entry.
export interface NavItem {
  label: string
  path: string
  live?: boolean // renders the pulsing "live" dot, matching the reference nav
}

export const navItems: NavItem[] = [
  { label: 'Dashboard', path: '/' },
  { label: 'Live', path: '/live', live: true },
  { label: 'Debug', path: '/debug' },
  { label: 'History', path: '/history' },
]

export const routes: Route[] = [
  { path: '/', component: Dashboard },
  { path: '/task/:id', component: TaskDetail },
  { path: '/history', component: History },
  { path: '/live', component: Live },
  { path: '/debug', component: Debug },
  { path: '/p/:slug', component: UserPage },
]

export interface RouteMatch {
  component: PageComponent
  params: Record<string, string>
}

// matchPattern returns the captured params if `pattern` matches `pathname`, else
// null. A ":name" segment captures one path segment; all other segments must match
// literally. Trailing slashes are ignored (except the root "/").
function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const norm = (p: string) => (p !== '/' && p.endsWith('/') ? p.slice(0, -1) : p)
  const pSegs = norm(pattern).split('/')
  const aSegs = norm(pathname).split('/')
  if (pSegs.length !== aSegs.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < pSegs.length; i++) {
    const ps = pSegs[i]
    const as = aSegs[i]
    if (ps.startsWith(':')) {
      params[ps.slice(1)] = decodeURIComponent(as)
    } else if (ps !== as) {
      return null
    }
  }
  return params
}

// resolve maps a pathname to its page component + extracted params, falling back
// to NotFound. Literal routes win over param routes because they are listed first
// and only one pattern of a given segment count can match a concrete path anyway.
export function resolve(pathname: string): RouteMatch {
  for (const r of routes) {
    const params = matchPattern(r.path, pathname)
    if (params) return { component: r.component, params }
  }
  return { component: NotFound, params: {} }
}
