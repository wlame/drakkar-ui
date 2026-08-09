import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _importModule,
  getRenderer,
  loadCustomRenderers,
  resetRenderersForTest,
  type RendererFn,
} from './renderers'

afterEach(() => {
  resetRenderersForTest()
  vi.restoreAllMocks()
})

// Stubs the dynamic-import boundary (see renderers.ts's comment on
// `_importModule`) to resolve with a given module shape, without any real
// network fetch or a literal import specifier vi.mock could intercept.
function stubImport(resolved: unknown) {
  _importModule.load = vi.fn().mockResolvedValue(resolved)
}

describe('loadCustomRenderers', () => {
  it('registers the module default export so getRenderer resolves a known name', async () => {
    const widgetRenderer: RendererFn = () => document.createElement('span')
    stubImport({ default: { widget: widgetRenderer } })

    await loadCustomRenderers()

    expect(getRenderer('widget')).toBe(widgetRenderer)
  })

  it('leaves the registry empty and warns once when the default export is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubImport({})

    await loadCustomRenderers()

    expect(getRenderer('widget')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('leaves the registry empty and warns once when the import rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    _importModule.load = vi.fn().mockRejectedValue(new Error('network down'))

    await loadCustomRenderers()

    expect(getRenderer('widget')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: a second call reuses the first import', async () => {
    const load = vi.fn().mockResolvedValue({ default: {} })
    _importModule.load = load

    await loadCustomRenderers()
    await loadCustomRenderers()

    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('getRenderer', () => {
  it('returns null for a name the module never registered', async () => {
    stubImport({ default: { known: () => document.createElement('div') } })
    await loadCustomRenderers()

    expect(getRenderer('unknown')).toBeNull()
  })

  it('returns null when the named entry is not a function', async () => {
    stubImport({ default: { notAFunction: 42 } })
    await loadCustomRenderers()

    expect(getRenderer('notAFunction')).toBeNull()
  })

  it('returns null before any load has been attempted', () => {
    expect(getRenderer('widget')).toBeNull()
  })
})
