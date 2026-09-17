import React from 'react'

interface CommitNumberFieldProps {
  label: string
  accessibleLabel: string
  value: number
  unit: string
  disabled?: boolean
  min?: number
  max?: number
  context: unknown
  onStart: () => void
  onCommit: (value: number) => void
}

const formatNumber = (value: number) => String(Math.round(value * 100) / 100)

/** 草稿绑定图层、帧与编辑模式；切换上下文不会将旧值提交到新目标。 */
export function CommitNumberField({ label, accessibleLabel, value, unit, disabled, min, max, context, onStart, onCommit }: CommitNumberFieldProps) {
  const [draft, setDraft] = React.useState(() => formatNumber(value))
  const editing = React.useRef(false)
  const changed = React.useRef(false)
  const source = React.useRef(context)

  React.useEffect(() => {
    if (source.current !== context) {
      editing.current = false
      changed.current = false
      source.current = context
    }
    if (!editing.current) setDraft(formatNumber(value))
  }, [value, context])

  return (
    <label className="block min-w-0">
      <span className="mb-1 flex items-center justify-between text-[11px] text-text-secondary">
        <span>{label}</span><span className="text-text-muted">{unit}</span>
      </span>
      <input
        type="number" aria-label={accessibleLabel} title="回车或失焦应用，Esc 取消"
        value={draft} min={min} max={max} step={0.1} disabled={disabled}
        className="w-full rounded border border-border bg-bg-tertiary px-2 py-1.5 text-xs font-mono text-text-primary outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
        onFocus={() => { editing.current = true; changed.current = false; source.current = context; onStart() }}
        onChange={event => {
          // 暂停播放会同步实际帧；用户继续输入时以暂停后的帧重新开始草稿。
          if (!editing.current) { editing.current = true; source.current = context }
          changed.current = true
          setDraft(event.target.value)
        }}
        onBlur={() => {
          if (!editing.current || source.current !== context) return
          editing.current = false
          if (disabled || !changed.current) { setDraft(formatNumber(value)); return }
          const number = draft.trim() === '' ? NaN : Number(draft)
          if (!Number.isFinite(number)) { setDraft(formatNumber(value)); return }
          const next = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, number))
          setDraft(formatNumber(next))
          if (next !== value) onCommit(next)
        }}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
          if (event.key === 'Escape') {
            event.preventDefault(); editing.current = false; setDraft(formatNumber(value)); event.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}
