// Regression coverage for the nullable `text` prop: a field the backend
// legitimately omitted (e.g. ProbeError has no traceback by contract) must
// render as an empty block — not throw inside a derived and take the whole
// parent branch's DOM down with it.
import { describe, expect, it } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import CodeBlock from './CodeBlock.svelte'

function mountCodeBlock(text: string | null | undefined): {
  target: HTMLElement
  dispose: () => void
} {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(CodeBlock, { target, props: { text } })
  flushSync()
  return {
    target,
    dispose: () => {
      unmount(app)
      target.remove()
    },
  }
}

describe('CodeBlock', () => {
  it('renders an empty block instead of throwing when text is undefined', () => {
    const { target, dispose } = mountCodeBlock(undefined)
    expect(target.querySelector('pre.block')?.textContent).toBe('')
    dispose()
  })

  it('renders an empty block instead of throwing when text is null', () => {
    const { target, dispose } = mountCodeBlock(null)
    expect(target.querySelector('pre.block')?.textContent).toBe('')
    dispose()
  })

  it('renders the given text when it is a plain string', () => {
    const { target, dispose } = mountCodeBlock('hello world')
    expect(target.querySelector('pre.block')?.textContent).toBe('hello world')
    dispose()
  })
})
