const REVEAL_LAYER_EVENT = 'svga-reveal-layer'

/** 跨面板定位只改变选择与列表视图，不修改动画或播放位置。 */
export function requestLayerReveal(id: string) {
  window.dispatchEvent(new CustomEvent(REVEAL_LAYER_EVENT, { detail: { id } }))
}

export function listenForLayerReveal(onReveal: (id: string) => void) {
  const listener = (event: Event) => {
    const id = (event as CustomEvent<{ id?: unknown }>).detail?.id
    if (typeof id === 'string') onReveal(id)
  }
  window.addEventListener(REVEAL_LAYER_EVENT, listener)
  return () => window.removeEventListener(REVEAL_LAYER_EVENT, listener)
}
