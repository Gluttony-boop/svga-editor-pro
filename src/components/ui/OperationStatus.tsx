import { cn } from '@/utils/cn'

export interface OperationStatusValue {
  kind: 'processing' | 'ready' | 'success' | 'cancelled' | 'error' | 'stale' | 'warning'
  message: string
}

const statusColors: Record<OperationStatusValue['kind'], string> = {
  processing: 'text-text-secondary',
  ready: 'text-accent',
  success: 'text-success',
  cancelled: 'text-text-muted',
  error: 'text-error',
  stale: 'text-warning',
  warning: 'text-warning'
}

/** 状态由业务明确指定，不从提示文案猜测成功或失败。 */
export function OperationStatus({ status, className }: { status: OperationStatusValue | null; className?: string }) {
  if (!status) return null
  return <p role={status.kind === 'error' ? 'alert' : 'status'} aria-atomic="true" data-status={status.kind} className={cn('text-xs', statusColors[status.kind], className)}>{status.message}</p>
}
