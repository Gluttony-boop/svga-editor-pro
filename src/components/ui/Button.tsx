import React from 'react'
import { cn } from '@/utils/cn'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: React.ReactNode
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'secondary', size = 'md', loading, icon, children, disabled, ...props }, ref) => {
    const variants = {
      primary: 'bg-accent hover:bg-accent-hover text-[#21131a] shadow-glow',
      secondary: 'bg-bg-tertiary hover:bg-border text-text-primary border border-border',
      ghost: 'bg-transparent hover:bg-bg-secondary text-text-secondary hover:text-text-primary',
      danger: 'bg-error hover:bg-red-600 text-white'
    }

    const sizes = {
      sm: 'min-h-8 px-2.5 py-1.5 text-sm',
      md: 'min-h-9 px-3 py-2 text-sm',
      lg: 'min-h-11 px-4 py-2.5 text-base'
    }

    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap',
          'transition-colors duration-150',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          variants[variant],
          sizes[size],
          className
        )}
        disabled={disabled || loading}
        type="button"
        {...props}
      >
        {loading ? (
          <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        ) : icon}
        {children}
      </button>
    )
  }
)

Button.displayName = 'Button'
