import react from 'eslint-plugin-react';
import unusedImports from 'eslint-plugin-unused-imports';

const runtimeGlobals = Object.fromEntries([
  'AbortController',
  'AbortSignal',
  'Blob',
  'Buffer',
  'CanvasRenderingContext2D',
  'cancelAnimationFrame',
  'clearTimeout',
  'console',
  'crypto',
  'CustomEvent',
  'document',
  'DOMParser',
  'Element',
  'Event',
  'fetch',
  'File',
  'FileReader',
  'FormData',
  'Headers',
  'HTMLCanvasElement',
  'Image',
  'IntersectionObserver',
  'KeyboardEvent',
  'localStorage',
  'MouseEvent',
  'navigator',
  'performance',
  'PointerEvent',
  'process',
  'queueMicrotask',
  'requestAnimationFrame',
  'Response',
  'ResizeObserver',
  'setInterval',
  'setTimeout',
  'TextDecoder',
  'TextEncoder',
  'URL',
  'URLSearchParams',
  'window',
  'Worker',
  'atob'
].map((name) => [name, 'readonly']));

export default [
  {
    files: ['src/**/*.{js,jsx,mjs}'],
    plugins: { react, 'unused-imports': unusedImports },
    settings: { react: { version: 'detect' } },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: runtimeGlobals
    },
    rules: {
      'react/jsx-uses-vars': 'error',
      'no-undef': ['error', { typeof: true }],
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': ['warn', { vars: 'all', varsIgnorePattern: '^_', args: 'none' }]
    }
  }
];
