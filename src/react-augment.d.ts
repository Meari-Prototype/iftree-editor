// React 模块增强：允许 style 里写 CSS 自定义属性（--xxx）。
// 模块增强必须在模块作用域文件里，故与 env.d.ts 的全局声明分开。

import 'react';

declare module 'react' {
  interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }
}
