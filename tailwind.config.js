/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx,html}', './public/**/*.html'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#A855F7',
          500: '#A855F7',
        },
        accent: {
          DEFAULT: '#EC4899',
          500: '#EC4899',
        },
      },
    },
  },
  plugins: [],
};
