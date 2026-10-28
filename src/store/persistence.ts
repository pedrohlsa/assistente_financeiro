/** Grava o último snapshot, com descarga imediata antes de sair da página. */
export function createDeferredSave<T>(write: (snapshot: T) => void, delay = 150) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: { snapshot: T } | undefined

  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    pending = undefined
  }
  const flush = () => {
    const latest = pending
    cancel()
    if (latest) write(latest.snapshot)
  }
  const queue = (snapshot: T) => {
    cancel()
    pending = { snapshot }
    timer = setTimeout(flush, delay)
  }
  return { queue, flush, cancel }
}
