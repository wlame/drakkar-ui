// Raw-DOM mount harness (mount/flushSync/unmount), matching the pattern in
// CodeBlock.test.ts and UserDetailsTab.test.ts. `../lib/renderers` is mocked
// so these tests exercise CustomCell's own try/catch and fallback behavior in
// isolation from the registry's own loading logic (covered by renderers.test.ts).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'

vi.mock('../lib/renderers', () => ({
  getRenderer: vi.fn(),
}))

import { getRenderer } from '../lib/renderers'
import CustomCell from './CustomCell.svelte'

const mockedGetRenderer = vi.mocked(getRenderer)

function renderCell(props: {
  name: string
  value: unknown
  row?: Record<string, unknown>
  cellKey?: string
  fallbackText: string
}) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(CustomCell, { target, props })
  flushSync()
  return {
    target,
    cleanup: () => {
      unmount(app)
      target.remove()
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CustomCell', () => {
  it('mounts the element a registered renderer returns', () => {
    mockedGetRenderer.mockReturnValue(() => {
      const el = document.createElement('strong')
      el.textContent = 'rendered'
      return el
    })

    const { target, cleanup } = renderCell({ name: 'widget', value: 1, fallbackText: 'fallback' })

    expect(target.querySelector('strong')?.textContent).toBe('rendered')
    cleanup()
  })

  it('falls back to plain text and warns once when the renderer throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockedGetRenderer.mockReturnValue(() => {
      throw new Error('boom')
    })

    const { target, cleanup } = renderCell({
      name: 'widget',
      value: 1,
      fallbackText: 'fallback text',
    })

    expect(target.textContent).toBe('fallback text')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('widget')
    cleanup()
  })

  it('falls back to plain text when no renderer is registered under the name', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockedGetRenderer.mockReturnValue(null)

    const { target, cleanup } = renderCell({
      name: 'missing',
      value: 1,
      fallbackText: 'fallback text',
    })

    expect(target.textContent).toBe('fallback text')
    cleanup()
  })

  it('falls back to plain text when the renderer returns a non-HTMLElement', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockedGetRenderer.mockReturnValue(
      (() => 'not an element') as unknown as ReturnType<typeof getRenderer>,
    )

    const { target, cleanup } = renderCell({
      name: 'widget',
      value: 1,
      fallbackText: 'fallback text',
    })

    expect(target.textContent).toBe('fallback text')
    cleanup()
  })
})
