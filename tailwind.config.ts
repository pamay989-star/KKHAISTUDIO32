import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        kkh: {
          bg: '#0E0918',
          card: '#181029',
          panel: '#24173D',
          purple: '#8B5CF6',
          violet: '#A855F7',
          soft: '#C084FC'
        }
      }
    }
  },
  plugins: []
} satisfies Config;
