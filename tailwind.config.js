/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 专业深色模式色彩方案
        'bg-primary': '#101419',
        'bg-secondary': '#1a2028',
        'bg-tertiary': '#242c37',
        'accent': '#f08095',
        'accent-hover': '#f69aad',
        'text-primary': '#e9edf4',
        'text-secondary': '#b6c0ce',
        'text-muted': '#8d9aad',
        'success': '#65d4ac',
        'warning': '#ebbc6d',
        'error': '#ff8091',
        'border': '#323c49',
        'border-light': '#4a586b',
      },
      fontFamily: {
        'sans': ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Microsoft YaHei', 'sans-serif'],
        'mono': ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      fontSize: {
        'xs': '12px',
        'sm': '13px',
        'base': '14px',
        'lg': '16px',
        'xl': '20px',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      boxShadow: {
        'glow': '0 2px 8px rgba(0, 0, 0, 0.18)',
        'panel': '0 4px 6px -1px rgba(0, 0, 0, 0.3)',
      }
    },
  },
  plugins: [],
}
