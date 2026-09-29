import React from 'react'
import { Button, Icon } from '@/components/ui'
import type { StarterTask } from '@/core/task-examples'

const skipKey = 'svga-starter-tasks-skipped-v1'
const STARTER_TASKS: { id: StarterTask; title: string; icon: string; description: string; guide: string }[] = [
  { id: 'profile', title: '换头像昵称', icon: 'image', description: '替换一张图片，预览长昵称。', guide: '在素材面板替换 avatar，选择仅当前层或所有引用；在插槽中修改 nickname_text 的文案与文字框宽度。文字默认仅模拟，需固定进 SVGA 时选择转图片写入。' },
  { id: 'compress', title: '压缩到指定大小', icon: 'export', description: '设置体积目标，核对实际结果。', guide: '在导出面板填写目标 KiB，选择压缩方案并生成导出预览。根据实际大小继续调节；不会自动保证达标，保存前还要检查画质与播放器兼容性。' },
  { id: 'batch', title: '批量生成', icon: 'layer', description: '一套动画，多条文案，逐条交付。', guide: '选择当前示例作为模板 → 填入示例或导入 CSV/JSON → 抽样核对实际 SVGA 与设计模拟 → 确认后批量生成。生产不改当前画布。' },
  { id: 'delivery', title: '检查交付', icon: 'check', description: '把动画、Key 清单和报告一起交付。', guide: '在专业交付包中设置目标播放器和体积预算，生成后核对检查报告及实际 SVGA 预览。报告不代替目标设备实测。' },
]

function initialSkipped() {
  try { return localStorage.getItem(skipKey) === 'true' } catch { return false }
}

export function TaskStarter({ onStart, onOpenFile, onSvgaDrop }: {
  onStart: (task: StarterTask) => void | Promise<void>
  onOpenFile?: () => void
  onSvgaDrop?: (file: File) => void | Promise<void>
}) {
  const [skipped, setSkipped] = React.useState(initialSkipped)
  const [busy, setBusy] = React.useState<StarterTask | null>(null)
  const [error, setError] = React.useState('')
  const busyRef = React.useRef(false)
  const chooseVisibility = (skip: boolean) => {
    setSkipped(skip)
    try { localStorage.setItem(skipKey, String(skip)) } catch { /* 存储不可用时仍允许直接开始。 */ }
  }
  const start = async (task: StarterTask) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(task); setError('')
    try { await onStart(task) }
    catch (reason) { setError(`示例未打开：${reason instanceof Error ? reason.message : String(reason)}`) }
    finally { busyRef.current = false; setBusy(null) }
  }
  return <section aria-label="开始任务" className="m-auto w-full max-w-2xl rounded-2xl border border-border bg-bg-secondary/95 p-5 shadow-xl"
    onMouseDown={event => event.stopPropagation()}
    onDragOver={event => event.preventDefault()}
    onDrop={event => {
      event.preventDefault(); event.stopPropagation()
      const file = event.dataTransfer.files[0]
      if (file && !busyRef.current) void Promise.resolve(onSvgaDrop?.(file)).catch(reason => setError(String(reason)))
    }}>
    <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
      <div><h2 className="text-lg font-medium text-text-primary">{skipped ? '开始编辑你的动画' : '先完成一件事'}</h2><p className="mt-1 text-xs text-text-muted">{skipped ? '打开文件，进入专业工作区。' : '选一个任务，用示例上手；也可以直接打开自己的文件。'}</p></div>
      {!skipped && <Button size="sm" variant="ghost" onClick={() => chooseVisibility(true)}>跳过任务入口</Button>}
    </div>
    {!skipped && <div className="grid grid-cols-2 gap-2">
      {STARTER_TASKS.map(task => <button key={task.id} type="button" disabled={!!busy} aria-label={`示例：${task.title}`}
        onClick={() => { void start(task.id) }}
        className="min-w-0 rounded-xl border border-border bg-bg-primary/50 p-3 text-left transition-colors hover:border-accent/60 hover:bg-accent/5 focus-visible:outline-accent disabled:opacity-50">
        <Icon name={task.icon} size={20} className="mb-2 text-accent" />
        <span className="block text-sm font-medium text-text-primary">{busy === task.id ? '正在准备示例…' : task.title}</span>
        <span className="mt-1 block text-[11px] leading-relaxed text-text-muted">{task.description}</span>
      </button>)}
    </div>}
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
      <Button variant="primary" disabled={!!busy} onClick={onOpenFile}><Icon name="folder-open" size={16} />打开动画 / 工程</Button>
      <span className="text-[11px] text-text-muted">也可拖入文件 · Ctrl/⌘ + O</span>
      {skipped && <Button size="sm" variant="ghost" onClick={() => chooseVisibility(false)}>显示任务入口</Button>}
    </div>
    {!skipped && <p className="mt-3 text-[10px] leading-relaxed text-text-muted">四套原创几何示例 · CC0，可修改与商用 · 本机生成，不上传素材。</p>}
    {error && <p role="alert" className="mt-2 text-xs text-warning">{error}</p>}
  </section>
}

export function StarterTaskGuide({ task, onContinue, onClose }: { task: StarterTask; onContinue: () => void; onClose: () => void }) {
  const entry = STARTER_TASKS.find(item => item.id === task)!
  return <aside aria-label="示例任务引导" className="flex flex-shrink-0 items-start gap-2 border-b border-accent/20 bg-bg-secondary px-3 py-2">
    <div className="min-w-0 flex-1"><p className="text-xs font-medium text-accent">示例 · {entry.title}</p><p className="mt-1 text-[11px] leading-relaxed text-text-secondary">{entry.guide}</p></div>
    <div className="flex flex-shrink-0 flex-col gap-1"><Button size="sm" onClick={onContinue}>打开操作入口</Button><Button size="sm" variant="ghost" onClick={onClose}>关闭引导</Button></div>
  </aside>
}
