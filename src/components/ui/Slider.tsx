import React from 'react'
import { cn } from '@/utils/cn'

export interface SliderProps {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (value: number) => void
  label?: string
  showValue?: boolean
  unit?: string
  className?: string
}

export const Slider: React.FC<SliderProps> = ({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  label,
  showValue = true,
  unit = '',
  className
}) => {
  const percentage = ((value - min) / (max - min)) * 100

  return (
    <div className={cn('w-full', className)}>
      {(label || showValue) && (
        <div className="flex justify-between items-center mb-2">
          {label && (
            <label className="text-xs text-text-secondary font-medium">
              {label}
            </label>
          )}
          {showValue && (
            <span className="text-xs text-text-primary">
              {value}{unit}
            </span>
          )}
        </div>
      )}
      <div className="relative">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full h-1 bg-border rounded-lg appearance-none cursor-pointer
                     [&::-webkit-slider-thumb]:appearance-none
                     [&::-webkit-slider-thumb]:w-3
                     [&::-webkit-slider-thumb]:h-3
                     [&::-webkit-slider-thumb]:bg-accent
                     [&::-webkit-slider-thumb]:rounded-full
                     [&::-webkit-slider-thumb]:cursor-pointer
                     [&::-webkit-slider-thumb]:shadow-glow
                     [&::-moz-range-thumb]:w-3
                     [&::-moz-range-thumb]:h-3
                     [&::-moz-range-thumb]:bg-accent
                     [&::-moz-range-thumb]:rounded-full
                     [&::-moz-range-thumb]:cursor-pointer
                     [&::-moz-range-thumb]:border-0"
        />
        {/* 进度条填充 */}
        <div 
          className="absolute top-1/2 left-0 h-1 bg-accent/50 rounded-l-lg pointer-events-none -translate-y-1/2"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  )
}
