/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Pretendard/JetBrains Mono 는 self-host (client/public/fonts, index.css 참고).
        // OS 기본 글꼴로 떨어지면 맥/윈도우 글자 크기가 달라지므로 웹폰트를 앞에 둔다.
        sans: ['Pretendard', '-apple-system', 'BlinkMacSystemFont', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
      }
    }
  },
  plugins: []
};
