// checkJs 的全局 ambient 声明：Vite 资源后缀导入 + preload 暴露的 window.iftree。
// 只服务类型检查（tsconfig.check.json），不参与构建。React 增强见 react-augment.d.ts。

interface Window {
  iftree?: Record<string, unknown>;
}

declare module '*.css';

declare module '*?url' {
  const url: string;
  export default url;
}
