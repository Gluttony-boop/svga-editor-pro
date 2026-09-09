export interface WindowCloseOptions {
  isDirty: () => boolean
  confirm: () => Promise<'save' | 'discard' | 'cancel'>
  save: () => Promise<boolean>
  destroy: () => Promise<void>
  onError: (error: unknown) => void
}

/** One confirmation/save/close operation at a time. Never re-emit closeRequested. */
export function createWindowCloseHandler(options: WindowCloseOptions) {
  let busy = false
  let disposed = false
  const handle = async (event: { preventDefault: () => void }) => {
    // The SDK otherwise calls destroy outside our error handler after this resolves.
    event.preventDefault()
    if (busy || disposed) return
    busy = true
    try {
      if (options.isDirty()) {
        const choice = await options.confirm()
        if (disposed || choice === 'cancel') return
        if (choice === 'save' && !await options.save()) return
      }
      if (!disposed) await options.destroy()
    } catch (error) {
      if (!disposed) options.onError(error)
    } finally {
      busy = false
    }
  }
  return { handle, dispose: () => { disposed = true } }
}
