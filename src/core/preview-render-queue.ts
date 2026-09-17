/** 串行处理预览，只保留尚未开始的最新一次请求。 */
export class PreviewRenderQueue<T> {
  private revision = 0
  private pending: { value: T; revision: number } | null = null
  private running = false

  constructor(
    private readonly render: (value: T, isCurrent: () => boolean) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => {}
  ) {}

  request(value: T): void {
    this.pending = { value, revision: ++this.revision }
    void this.flush()
  }

  invalidate(): void {
    this.revision++
    this.pending = null
  }

  private async flush(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.pending) {
        const request = this.pending
        this.pending = null
        const isCurrent = () => request.revision === this.revision
        try {
          await this.render(request.value, isCurrent)
        } catch (error) {
          if (isCurrent()) this.onError(error)
        }
      }
    } finally {
      this.running = false
    }
  }
}
