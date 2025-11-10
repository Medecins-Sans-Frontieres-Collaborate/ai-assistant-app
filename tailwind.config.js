/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './pages/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
    './node_modules/streamdown/dist/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          '"Noto Sans"',
          'sans-serif',
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
          '"Segoe UI Symbol"',
          '"Noto Color Emoji"',
        ],
      },
      typography: {
        DEFAULT: {
          css: {
            maxWidth: 'none', // Remove default prose max-width constraint
            fontFamily: [
              'system-ui',
              '-apple-system',
              'BlinkMacSystemFont',
              '"Segoe UI"',
              'Roboto',
              '"Helvetica Neue"',
              'Arial',
              '"Noto Sans"',
              'sans-serif',
              '"Apple Color Emoji"',
              '"Segoe UI Emoji"',
              '"Segoe UI Symbol"',
              '"Noto Color Emoji"',
            ].join(', '),
          },
        },
      },
      keyframes: {
        'scroll-text': {
          '0%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(-100%)' },
        },
        'scroll-text-pause': {
          '0%': { transform: 'translateX(0%)' },
          '10%': { transform: 'translateX(0%)' },
          '40%': { transform: 'translateX(-100%)' },
          '50%': { transform: 'translateX(-100%)' },
          '60%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(0%)' },
        },
        indeterminate: {
          '0%': { left: '-50%', width: '50%' },
          '50%': { left: '25%', width: '50%' },
          '100%': { left: '100%', width: '0%' },
        },
        'progress-bar-stripes': {
          '0%': { backgroundPosition: '1rem 0' },
          '100%': { backgroundPosition: '0 0' },
        },
        'animate-pulse': {
          '0%': { opacity: 1 },
          '50%': { opacity: 0.5 },
          '100%': { opacity: 1 },
        },
        'spin-slow': {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        'bounce-dot': {
          '0%, 80%, 100%': {
            transform: 'translateY(0)',
            animationTimingFunction: 'cubic-bezier(0.8, 0, 1, 1)',
          },
          '40%': {
            transform: 'translateY(-0.5rem)',
            animationTimingFunction: 'cubic-bezier(0, 0, 0.2, 1)',
          },
        },
        breathing: {
          '0%, 100%': {
            transform: 'scale(0.25)',
            opacity: '0.3',
          },
          '50%': {
            transform: 'scale(1.0)',
            opacity: '1',
          },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-in-from-top': {
          '0%': { transform: 'translateY(-1rem)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'slide-in-from-bottom': {
          '0%': { transform: 'translateY(1rem)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'modal-in': {
          '0%': {
            transform: 'translateY(1rem) scale(0.95)',
            opacity: '0',
          },
          '100%': {
            transform: 'translateY(0) scale(1)',
            opacity: '1',
          },
        },
        'slide-up': {
          '0%': { transform: 'translateY(0.5rem)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'slide-down': {
          '0%': { transform: 'translateY(0)', opacity: '1' },
          '100%': { transform: 'translateY(0.5rem)', opacity: '0' },
        },
        'slide-down-reverse': {
          '0%': { transform: 'translateY(-0.5rem)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'slide-in-right': {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        'slide-out-right': {
          '0%': { transform: 'translateX(0)', opacity: '1' },
          '100%': { transform: 'translateX(100%)', opacity: '0' },
        },
        'fade-out': {
          '0%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'scroll-text': 'scroll-text 10s linear infinite',
        'scroll-text-auto': 'scroll-text-pause 12s ease-in-out infinite',
        indeterminate: 'indeterminate 1.5s infinite',
        'progress-bar-stripes': 'progress-bar-stripes 1s linear infinite',
        'animate-pulse': 'pulse 2s infinite',
        'spin-slow': 'spin-slow 4s linear infinite',
        'bounce-dot-1': 'bounce-dot 1.4s infinite 0s',
        'bounce-dot-2': 'bounce-dot 1.4s infinite 0.2s',
        'bounce-dot-3': 'bounce-dot 1.4s infinite 0.4s',
        breathing: 'breathing 1.5s ease-in-out infinite',
        'fade-in': 'fade-in 0.5s ease-out forwards',
        'fade-in-fast': 'fade-in 0.2s ease-out forwards',
        'fade-in-top': 'slide-in-from-top 0.7s ease-out forwards',
        'fade-in-bottom': 'slide-in-from-bottom 0.7s ease-out 0.15s forwards',
        'modal-in': 'modal-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-up': 'slide-up 0.2s ease-out',
        'slide-down': 'slide-down 0.2s ease-in',
        'slide-down-reverse': 'slide-down-reverse 0.2s ease-out',
        'slide-in-right':
          'slide-in-right 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-out-right':
          'slide-out-right 0.2s cubic-bezier(0.4, 0, 1, 1) forwards',
        'fade-out': 'fade-out 0.2s ease-out forwards',
        shimmer: 'shimmer 4s linear infinite',
      },
    },
  },
  variants: {
    extend: {
      visibility: ['group-hover'],
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
