import react from 'eslint-plugin-react';
import unusedImports from 'eslint-plugin-unused-imports';
import tsParser from '@typescript-eslint/parser';

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

// electron 主进程 / scripts / tests 的 Node 运行时全局名单。
const nodeGlobals = Object.fromEntries([
  'AbortController',
  'AbortSignal',
  'Blob',
  'Buffer',
  'clearImmediate',
  'clearInterval',
  'clearTimeout',
  'console',
  'crypto',
  'fetch',
  'global',
  'performance',
  'process',
  'queueMicrotask',
  'Response',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'structuredClone',
  'TextDecoder',
  'TextEncoder',
  'URL',
  'URLSearchParams',
  'WebSocket'
].map((name) => [name, 'readonly']));

const cjsGlobals = Object.fromEntries(
  ['require', 'module', 'exports', '__dirname', '__filename'].map((name) => [name, 'readonly'])
);

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
  },
  {
    // 渲染进程 TS 文件：no-undef 交给 tsc（npm run check:types）——TS parser
    // 下该规则对类型标注会误报，且 tsc 的未定义检查严于 eslint。
    // .d.ts 是 ambient 声明（declaration merging 必然"未使用"），归 tsc 管。
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.d.ts'],
    plugins: { react, 'unused-imports': unusedImports },
    settings: { react: { version: 'detect' } },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: runtimeGlobals
    },
    rules: {
      'react/jsx-uses-vars': 'error',
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': ['warn', { vars: 'all', varsIgnorePattern: '^_', args: 'none' }]
    }
  },
  {
    files: ['electron/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}', 'tests/**/*.{js,mjs}'],
    plugins: { 'unused-imports': unusedImports },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals
    },
    rules: {
      'no-undef': ['error', { typeof: true }],
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': ['warn', { vars: 'all', varsIgnorePattern: '^_', args: 'none' }]
    }
  },
  {
    // electron 主进程 / scripts 的 TS 文件：no-undef 交给 tsc（同 src TS 组），
    // tsParser 下该规则会对类型标注误报。
    files: ['electron/**/*.ts', 'scripts/**/*.ts'],
    plugins: { 'unused-imports': unusedImports },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals
    },
    rules: {
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': ['warn', { vars: 'all', varsIgnorePattern: '^_', args: 'none' }]
    }
  },
  {
    files: ['electron/**/*.cjs', 'scripts/**/*.cjs', 'tests/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...nodeGlobals, ...cjsGlobals }
    },
    rules: {
      'no-undef': ['error', { typeof: true }]
    }
  }
];
