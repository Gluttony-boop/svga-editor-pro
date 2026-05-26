import React from 'react'
import { Panel, Icon, Button, Input, NumberInput } from '@/components/ui'
import { useEditorStore } from '@/stores'
import type { SlotConfig } from '@/types'
import { cn } from '@/utils/cn'

interface SlotPanelProps {
  className?: string
  collapsible?: boolean
  defaultCollapsed?: boolean
}

export const SlotPanel: React.FC<SlotPanelProps> = ({ className, collapsible = true, defaultCollapsed = false }) => {
  const detectedSlots = useEditorStore((s) => s.detectedSlots)
  const slotConfigs = useEditorStore((s) => s.slotConfigs)
  const setSlotConfig = useEditorStore((s) => s.setSlotConfig)
  const removeSlotConfig = useEditorStore((s) => s.removeSlotConfig)
  const videoItem = useEditorStore((s) => s.videoItem)

  // 自动检测插槽
  const slots = React.useMemo(() => {
    if (detectedSlots.length > 0) return detectedSlots
    if (!videoItem?.movie.sprites) return []
    
    const slotSet = new Set<string>()
    videoItem.movie.sprites.forEach((sprite) => {
      const key = sprite.imageKey || ''
      // 检测插槽模式
      const slotMatch = key.match(/\$(.+?)(?:@|$)/)
      if (slotMatch) {
        slotSet.add(slotMatch[1])
      }
      if (key.includes('slot') || key.includes('Slot')) {
        slotSet.add(key)
      }
    })
    return Array.from(slotSet)
  }, [detectedSlots, videoItem])

  return (
    <Panel
      title="插槽配置"
      icon={<Icon name="magic" size={16} />}
      className={className}
      collapsible={collapsible}
      defaultCollapsed={defaultCollapsed}
    >
      {slots.length === 0 ? (
        <div className="text-center py-8 text-text-muted text-sm">
          <Icon name="magic" size={32} className="mx-auto mb-2 opacity-50" />
          <p>未检测到插槽</p>
          <p className="text-xs mt-1">打开包含插槽的 SVGA 文件</p>
        </div>
      ) : (
        <div className="space-y-3">
          {slots.map((slotName) => (
            <SlotItem
              key={slotName}
              name={slotName}
              config={slotConfigs[slotName]}
              onChange={(config) => setSlotConfig(slotName, config)}
              onRemove={() => removeSlotConfig(slotName)}
            />
          ))}
        </div>
      )}
    </Panel>
  )
}

interface SlotItemProps {
  name: string
  config?: SlotConfig
  onChange: (config: SlotConfig) => void
  onRemove: () => void
}

const SlotItem: React.FC<SlotItemProps> = ({ name, config, onChange, onRemove }) => {
  const [type, setType] = React.useState<'text' | 'image'>(config?.type || 'text')
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    setType(config?.type || 'text')
  }, [config?.type])

  const handleTextChange = (updates: Partial<{
    text: string
    fontSize: number
    fontFamily: string
    color: string
  }>) => {
    const textConfig = {
      text: config?.textConfig?.text || '',
      fontSize: config?.textConfig?.fontSize || 24,
      fontFamily: config?.textConfig?.fontFamily || 'Arial',
      color: config?.textConfig?.color || '#ffffff',
      ...updates
    }
    onChange({
      type: 'text',
      name,
      value: textConfig.text,
      textConfig
    })
  }

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const url = URL.createObjectURL(file)
      onChange({
        type: 'image',
        name,
        value: url,
        imageConfig: {
          url,
          scaleMode: 'fit'
        }
      })
    }
    e.target.value = ''
  }

  return (
    <div className="bg-bg-tertiary rounded-lg p-3">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-text-primary">{name}</span>
        <div className="flex items-center gap-1">
          <button
            className={cn(
              'px-2 py-1 text-xs rounded transition-colors',
              type === 'text' ? 'bg-accent text-white' : 'bg-border text-text-secondary hover:text-text-primary'
            )}
            onClick={() => {
              setType('text')
              onChange({ type: 'text', name, value: '' })
            }}
          >
            文本
          </button>
          <button
            className={cn(
              'px-2 py-1 text-xs rounded transition-colors',
              type === 'image' ? 'bg-accent text-white' : 'bg-border text-text-secondary hover:text-text-primary'
            )}
            onClick={() => {
              setType('image')
              fileInputRef.current?.click()
            }}
          >
            图片
          </button>
        </div>
      </div>

      {type === 'text' ? (
        <div className="space-y-2">
          <Input
            placeholder="输入文本内容"
            value={config?.textConfig?.text || ''}
            onChange={(e) => handleTextChange({ text: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberInput
              label="字号"
              value={config?.textConfig?.fontSize || 24}
              min={8}
              max={200}
              onChange={(v) => handleTextChange({ fontSize: v })}
            />
            <div>
              <label className="block text-xs text-text-secondary mb-1">颜色</label>
              <input
                type="color"
                value={config?.textConfig?.color || '#ffffff'}
                onChange={(e) => handleTextChange({ color: e.target.value })}
                className="w-full h-8 rounded cursor-pointer"
              />
            </div>
          </div>
        </div>
      ) : (
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageSelect}
            className="hidden"
          />
          {config?.imageConfig?.url ? (
            <div className="flex items-center gap-2">
              <div className="w-12 h-12 bg-bg-primary rounded overflow-hidden flex-shrink-0">
                <img
                  src={config.imageConfig.url}
                  alt="slot"
                  className="w-full h-full object-contain"
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                更换
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onRemove}
              >
                清除
              </Button>
            </div>
          ) : (
            <button
              className="w-full h-20 border-2 border-dashed border-border rounded-lg flex items-center justify-center hover:border-accent transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="plus" size={24} className="text-text-muted" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
