import { describe, it, expect, vi, afterEach } from 'vitest'
import { canUseClipboardApi, copyText } from './copy'

// happy-dom (this project's vitest environment) never implements
// `isSecureContext` (it is always `undefined`) and has no
// `document.execCommand` at all — unlike jsdom, which stubs both. Both
// pieces of DOM surface are therefore poked in directly with
// Object.defineProperty/plain assignment below rather than relying on the
// environment to provide them, and restored after each test so the fake
// clipboard/isSecureContext state from one test can't leak into the next.

function restoreProperty(obj: object, key: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(obj, key, descriptor)
  else delete (obj as Record<string, unknown>)[key]
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('canUseClipboardApi', () => {
  it('is false in a plain-HTTP context (isSecureContext undefined, no clipboard) — the normal debug-UI case', () => {
    expect(canUseClipboardApi()).toBe(false)
  })

  it('is true when isSecureContext is true and navigator.clipboard exists', () => {
    const secureDesc = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
    const clipboardDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn() },
      configurable: true,
    })
    try {
      expect(canUseClipboardApi()).toBe(true)
    } finally {
      restoreProperty(window, 'isSecureContext', secureDesc)
      restoreProperty(navigator, 'clipboard', clipboardDesc)
    }
  })

  it('is false when isSecureContext is true but navigator.clipboard is missing', () => {
    const secureDesc = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
    const clipboardDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    try {
      expect(canUseClipboardApi()).toBe(false)
    } finally {
      restoreProperty(window, 'isSecureContext', secureDesc)
      restoreProperty(navigator, 'clipboard', clipboardDesc)
    }
  })
})

describe('copyText', () => {
  it('uses navigator.clipboard.writeText when the secure-context branch is available', async () => {
    const secureDesc = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
    const clipboardDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      const ok = await copyText('hello')
      expect(ok).toBe(true)
      expect(writeText).toHaveBeenCalledWith('hello')
    } finally {
      restoreProperty(window, 'isSecureContext', secureDesc)
      restoreProperty(navigator, 'clipboard', clipboardDesc)
    }
  })

  it('falls back to execCommand when writeText rejects despite a secure context', async () => {
    const secureDesc = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
    const clipboardDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const execCommand = vi.fn().mockReturnValue(true)
    // happy-dom has no execCommand at all — install a fake so the fallback path
    // (the thing under test) actually runs to completion.
    ;(document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand
    try {
      const ok = await copyText('hello')
      expect(ok).toBe(true)
      expect(execCommand).toHaveBeenCalledWith('copy')
    } finally {
      restoreProperty(window, 'isSecureContext', secureDesc)
      restoreProperty(navigator, 'clipboard', clipboardDesc)
      delete (document as unknown as { execCommand?: unknown }).execCommand
    }
  })

  it('falls back to execCommand in the normal plain-HTTP case and copies via a hidden textarea', async () => {
    const execCommand = vi.fn().mockImplementation(function (this: Document) {
      // The fallback selects the textarea before invoking execCommand; assert
      // the DOM was actually wired up the way a real "copy" command needs.
      expect(document.body.contains(document.activeElement)).toBe(true)
      return true
    })
    ;(document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand
    try {
      const before = document.body.childElementCount
      const ok = await copyText('hidden textarea contents')
      expect(ok).toBe(true)
      expect(execCommand).toHaveBeenCalledWith('copy')
      // The scratch textarea is removed again once the copy completes.
      expect(document.body.childElementCount).toBe(before)
    } finally {
      delete (document as unknown as { execCommand?: unknown }).execCommand
    }
  })

  it('returns false when execCommand is not implemented at all', async () => {
    // This is happy-dom's actual default state — document.execCommand does
    // not exist as a function — exercised here without any stubbing.
    const ok = await copyText('no fallback available')
    expect(ok).toBe(false)
  })

  it('returns false when execCommand runs but reports failure', async () => {
    const execCommand = vi.fn().mockReturnValue(false)
    ;(document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand
    try {
      const ok = await copyText('rejected copy')
      expect(ok).toBe(false)
    } finally {
      delete (document as unknown as { execCommand?: unknown }).execCommand
    }
  })
})
