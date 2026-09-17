let timer: ReturnType<typeof setInterval> | null = null

self.onmessage = (event: MessageEvent<'start' | 'stop'>) => {
  if (event.data === 'stop') {
    if (timer !== null) clearInterval(timer)
    timer = null
  } else if (event.data === 'start' && timer === null) {
    timer = setInterval(() => self.postMessage('tick'), 16)
  }
}

export {}
