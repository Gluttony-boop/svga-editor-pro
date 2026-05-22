import React from 'react'
import { cn } from '@/utils/cn'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  icon?: React.ReactNode
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, icon, ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="block text-xs text-text-secondary font-medium mb-1.5">
            {label}
          </label>
        )}
        <div className="relative">
          {icon && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
              {icon}
            </div>
          )}
          <input
            ref={ref}
            className={cn(
              'w-full px-3 py-2 rounded-lg',
              'bg-bg-tertiary border border-border',
              'text-text-primary placeholder-text-muted',
              'focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent',
              'transition-all duration-200',
              icon && 'pl-10',
              error && 'border-error focus:border-error focus:ring-error',
              className
            )}
            {...props}
          />
        </div>
        {error && (
          <p className="mt-1 text-xs text-error">{error}</p>
        )}
      </div>
    )
  }
)

Input.displayName = 'Input'

export interface NumberInputProps extends Omit<InputProps, 'type' | 'onChange'> {
  min?: number
  max?: number
  step?: number
  unit?: string
  onChange?: (value: number) => void
}

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ onChange, min, max, step = 1, unit, ...props }, ref) => {
    return (
      <div className="w-full">
        {props.label && (
          <label className="block text-xs text-text-secondary font-medium mb-1.5 flex items-center justify-between">
            <span>{props.label}</span>
            {unit && <span className="text-text-muted">{unit}</span>}
          </label>
        )}
        <Input
          ref={ref}
          type="number"
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const value = parseFloat(e.target.value)
            if (!isNaN(value) && onChange) {
              onChange(value)
            }
          }}
          {...props}
          label={undefined}
        />
      </div>
    )
  }
)

NumberInput.displayName = 'NumberInput'
