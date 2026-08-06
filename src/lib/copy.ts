// copyText copies `text` to the system clipboard and reports whether it
// worked. `canUseClipboardApi` is split out so its branch — the thing that
// actually varies between environments — is unit-testable on its own; the
// two DOM calls it gates (`navigator.clipboard.writeText`,
// `document.execCommand`) are only meaningfully exercisable against a full
// browser or a DOM shim that implements them.

// canUseClipboardApi mirrors the MDN guidance: navigator.clipboard exists
// but is only *usable* in a secure context (HTTPS, or localhost). The
// drakkar debug UI is commonly reached over plain HTTP on a LAN (a worker's
// :8080), where isSecureContext is false and navigator.clipboard is simply
// undefined — so the execCommand fallback below is the NORMAL path for this
// product, not a legacy shim kept around for ancient browsers.
export function canUseClipboardApi(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.clipboard &&
    typeof window !== 'undefined' &&
    window.isSecureContext === true
  )
}

// copyWithExecCommand is the insecure-context fallback: stuff the text into
// an offscreen, unfocusable-by-tab textarea, select it, and ask the browser
// to copy the current selection. document.execCommand is deprecated but
// still implemented everywhere this fallback actually needs to run.
function copyWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
  const textarea = document.createElement('textarea')
  textarea.value = text
  // Off-screen rather than display:none — some browsers refuse to select
  // text inside an element that isn't actually rendered.
  textarea.style.position = 'fixed'
  textarea.style.top = '-1000px'
  textarea.style.left = '-1000px'
  textarea.setAttribute('readonly', '')
  document.body.appendChild(textarea)
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)
  let ok: boolean
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(textarea)
  return ok
}

// copyText copies `text` to the clipboard, returning whether it succeeded.
export async function copyText(text: string): Promise<boolean> {
  if (canUseClipboardApi()) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied or some other runtime failure — fall through to
      // the execCommand fallback rather than reporting failure outright.
    }
  }
  return copyWithExecCommand(text)
}
