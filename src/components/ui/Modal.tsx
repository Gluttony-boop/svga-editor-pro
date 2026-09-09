import React from 'react'
import { cn } from '@/utils/cn'

export interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
  isolateKeyboard?: boolean
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  className,
  isolateKeyboard = false
}) => {
  const dialogRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!isOpen || !isolateKeyboard) return
    const previous = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [isOpen, isolateKeyboard])
  React.useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    
    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
      document.body.style.overflow = 'hidden'
    }
    
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div 
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div 
        ref={dialogRef}
        tabIndex={isolateKeyboard ? -1 : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'bg-bg-secondary border border-border rounded-xl shadow-2xl',
          'max-w-lg w-full animate-fade-in',
          className
        )}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (!isolateKeyboard || e.key === 'Escape') return
          e.stopPropagation()
          if ((e.ctrlKey || e.metaKey) && ['s', 'o', 'e', 'z', 'y'].includes(e.key.toLowerCase())) e.preventDefault()
          if (e.key === 'Tab') {
            const elements = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')
            if (!elements?.length) return
            const first = elements[0], last = elements[elements.length - 1]
            if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last.focus() }
            if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
          }
        }}
      >
        {title && (
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <h3 className="text-lg font-medium text-text-primary">{title}</h3>
            <button 
              onClick={onClose}
              className="p-1 hover:bg-white/10 rounded transition-colors"
            >
              <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        <div className="px-6 py-4 max-h-[70vh] overflow-y-auto">
          {children}
        </div>
        {footer && (
          <div className="px-6 py-4 border-t border-border flex justify-end gap-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
