// Backend-declared UI pages (GET /api/v1/pages). Fetched once at boot
// (App.svelte, next to the identity load) so the nav can add an entry per
// declared page alongside the built-in ones. A backend that declares nothing
// — every Go worker today, and a Python worker without ui_pages configured —
// returns an empty array, so the nav shows only the built-ins.

import { writable, type Readable } from 'svelte/store'
import { api } from './api'
import type { UIPage } from './types'

const store = writable<UIPage[]>([])

export const uiPages: Readable<UIPage[]> = store

// loadUiPages fetches the declared pages and populates the store. Failure
// degrades silently to the empty list — matching how the identity fetch
// degrades in App.svelte — so a backend that predates /api/v1/pages, or one
// that's briefly unreachable, simply shows no extra nav entries rather than
// breaking the whole app shell.
export async function loadUiPages(): Promise<void> {
  try {
    store.set(await api.uiPages())
  } catch (e) {
    console.warn('failed to load declared UI pages', e)
    store.set([])
  }
}

// pageBySlug finds the declared page for a /p/:slug route, or null when the
// slug matches nothing (unknown/removed page — the route renders NotFound).
export function pageBySlug(pages: UIPage[], slug: string): UIPage | null {
  return pages.find((p) => p.slug === slug) ?? null
}
