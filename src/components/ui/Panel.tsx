import React from 'react'
import { cn } from '@/utils/cn'

export interface PanelProps {
  title?: string
  icon?: React.ReactNode
  headerAction?: React.ReactNode
  children: React.ReactNode
  className?: string
  contentClassName?: string
  collapsible?: boolean
  defaultCollapsed?: boolean
  style?: React.CSSProperties
}

export const Panel: React.FC<PanelProps> = ({
  title,
  icon,
  headerAction,
  children,
  className,
  contentClassName,
  collapsible = false,
  defaultCollapsed = false,
  style
}) => {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed)

  return (
    <div 
      className={cn(
        'bg-bg-secondary border border-border rounded-lg overflow-hidden flex flex-col',
        collapsed && 'flex-shrink-0',
        className
      )}
      style={style}
    >
      {title && (
        <div 
          className={cn(
            'px-4 py-3 border-b border-border flex items-center justify-between bg-bg-tertiary/50 flex-shrink-0',
            collapsible && 'cursor-pointer hover:bg-bg-tertiary'
          )}
          onClick={() => collapsible && setCollapsed(!collapsed)}
        >
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            {icon}
            {title}
            {collapsible && (
              <span className={cn(
                'transition-transform text-xs',
                collapsed && '-rotate-90'
              )}>
                ▼
              </span>
            )}
          </div>
          {headerAction && !collapsed && (
            <div onClick={(e) => e.stopPropagation()}>
              {headerAction}
            </div>
          )}
        </div>
      )}
      {!collapsed && (
        <div className={cn('p-4 overflow-y-auto flex-1', contentClassName)}>
          {children}
        </div>
      )}
    </div>
  )
}

export interface PanelSectionProps {
  title: string
  children: React.ReactNode
  className?: string
}

export const PanelSection: React.FC<PanelSectionProps> = ({
  title,
  children,
  className
}) => {
  return (
    <div className={cn('mb-4 last:mb-0', className)}>
      <h4 className="text-xs text-text-muted font-medium uppercase tracking-wide mb-2">
        {title}
      </h4>
      {children}
    </div>
  )
}
