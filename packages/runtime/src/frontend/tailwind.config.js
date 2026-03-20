/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        gray: { 950: '#0a0a0a' },
        red: { 950: '#1a0505' },
      },
    },
  },
  plugins: [],
};
