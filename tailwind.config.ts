import type { Config } from 'tailwindcss'

// Tokens live in globals.css as RGB channels so every colour supports
// Tailwind's `/alpha` modifier (e.g. `bg-accent/15`). The glass materials
// themselves (.glass, .glass-thick, .glass-tile, …) are component classes in
// globals.css; see DESIGN.md.
const channel = (name: string): string => `rgb(var(--${name}) / <alpha-value>)`

const config: Config = {
  darkMode: 'class',
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        canvas: channel('canvas'),
        surface: channel('surface'),
        raised: channel('raised'),
        overlay: channel('overlay'),
        ink: {
          DEFAULT: channel('ink'),
          muted: channel('ink-muted'),
          subtle: channel('ink-subtle'),
          faint: channel('ink-faint')
        },
        line: {
          DEFAULT: 'rgb(255 255 255 / 0.09)',
          strong: 'rgb(255 255 255 / 0.16)'
        },
        fill: {
          DEFAULT: 'rgb(255 255 255 / 0.05)',
          hover: 'rgb(255 255 255 / 0.08)',
          selected: 'rgb(255 255 255 / 0.11)'
        },
        accent: {
          DEFAULT: channel('accent'),
          hover: channel('accent-hover'),
          ink: channel('accent-ink'),
          cyan: channel('accent-cyan')
        },
        success: channel('success'),
        danger: channel('danger'),
        warning: channel('warning'),
        brand: {
          blue: '#38ccff',
          gold: '#ffd500'
        }
      },
      fontFamily: {
        sans: ['Geist', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif'],
        mono: ['"Geist Mono"', '"SF Mono"', 'ui-monospace', 'Menlo', 'monospace']
      },
      fontSize: {
        '2xs': ['11px', '14px'],
        xs: ['12px', '16px'],
        sm: ['13px', '18px'],
        base: ['14px', '20px'],
        lg: ['16px', '22px'],
        xl: ['20px', '26px'],
        '2xl': ['24px', '30px'],
        '3xl': ['30px', '36px'],
        '4xl': ['40px', '44px']
      },
      // Compact, soft corners. Nested shapes step down one size so corners
      // stay concentric (card 2xl → media xl).
      borderRadius: {
        sm: '6px',
        DEFAULT: '8px',
        md: '8px',
        lg: '10px',
        xl: '12px',
        '2xl': '14px',
        '3xl': '18px'
      },
      boxShadow: {
        panel: 'inset 0 1px 0 0 rgb(255 255 255 / 0.06), 0 1px 2px rgb(0 0 0 / 0.25), 0 18px 48px -24px rgb(0 0 0 / 0.6)',
        pop: 'inset 0 1px 0 rgb(255 255 255 / 0.1), 0 40px 100px -24px rgb(0 0 0 / 0.8), 0 12px 32px -12px rgb(0 0 0 / 0.55)',
        accent: '0 0 0 1px rgb(var(--accent) / 0.5)',
        'accent-ring':
          'inset 0 1px 0 rgb(255 255 255 / 0.12), 0 0 0 1px rgb(var(--accent) / 0.9), 0 0 0 4px rgb(var(--accent) / 0.18)'
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
        spring: 'cubic-bezier(0.34, 1.4, 0.64, 1)'
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        fade: {
          from: { opacity: '0' },
          to: { opacity: '1' }
        },
        'pop-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.97)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' }
        },
        'menu-in': {
          from: { opacity: '0', transform: 'scale(0.97)' },
          to: { opacity: '1', transform: 'scale(1)' }
        },
        'bar-grow': {
          from: { transform: 'scaleX(0)' },
          to: { transform: 'scaleX(1)' }
        },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgb(var(--accent) / 0.5)' },
          '100%': { boxShadow: '0 0 0 10px rgb(var(--accent) / 0)' }
        }
      },
      animation: {
        // `backwards`, not `both`: a transform left on after entry would make the
        // element the containing block for fixed descendants.
        'fade-in': 'fade-in 320ms cubic-bezier(0.16, 1, 0.3, 1) backwards',
        fade: 'fade 240ms ease-out backwards',
        'pop-in': 'pop-in 360ms cubic-bezier(0.16, 1, 0.3, 1) backwards',
        'menu-in': 'menu-in 140ms cubic-bezier(0.16, 1, 0.3, 1) backwards',
        'bar-grow': 'bar-grow 800ms cubic-bezier(0.16, 1, 0.3, 1) backwards',
        'pulse-ring': 'pulse-ring 1.8s cubic-bezier(0.16, 1, 0.3, 1) infinite'
      }
    }
  },
  plugins: []
}

export default config
