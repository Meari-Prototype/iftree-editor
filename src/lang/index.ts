// 语言 / 文案资源层（前后端共用的横切纯资源，位置与 core/ 同级）。
// 职责：把 markdown 文案文件解析成「命名空间.键 → 文案」目录，按键取值 + {{占位}} 插值。
// 解析与渲染是纯函数、零 I/O，前后端共用；「文案字符串怎么拿到」由各端自理——
// 后端用 loadPromptCatalog 读文件，前端将来在构建期把 md 作为字符串打包后喂给 parsePromptCatalog。
// 命名空间约定：prompt.* / agent.* / summary.* / memory.*（后端提示词，本轮填充）+ ui.*（前端文案，预留）。
// locale：默认 zh；其它 locale 用 system_prompt.<locale>.md，缺失回退默认 locale 文件。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_LOCALE = 'zh';

// 把 `## 段名\n正文…` 的 markdown 解析成 { 段名: 正文 } 目录。段名即「命名空间.键」（如 agent.base）。
// 一段从其 `## 段名` 行后延伸到下一个 `## ` 段或文件尾；首行单 `#` 大标题不计入。
export function parsePromptCatalog(markdown: unknown): Record<string, string> {
  const text = String(markdown || '');
  const catalog: Record<string, string> = {};
  const pattern = /^##\s+(.+?)\s*\r?\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/gm;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const key = match[1].trim();
    if (key) catalog[key] = match[2].trim();
  }
  return catalog;
}

// {{key}} 占位符插值（与旧 promptTemplate 等价）。
function interpolate(template: unknown, vars: Record<string, unknown> = {}): string {
  return String(template || '').replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_: string, key: string) => String(vars[key] ?? ''));
}

// 取某键文案并插值；键不存在时用 fallback（fallback 也缺则空串）。
// 与旧 systemPromptSection(name, fallback) + promptTemplate 合并等价。
export function renderPrompt(catalog: Record<string, string> | null | undefined, key: string, vars: Record<string, unknown> = {}, fallback = ''): string {
  const hasKey = catalog && Object.prototype.hasOwnProperty.call(catalog, key);
  return interpolate(hasKey ? catalog[key] : fallback, vars);
}

// 后端入口：读 locale 对应的 md 文案文件并解析成目录。
// zh → <baseDir>/system_prompt.md；其它 → <baseDir>/system_prompt.<locale>.md，缺失回退默认 locale 文件。
// 前端不走这条 fs 路径——改在构建期把 md 打包成字符串后直接喂给 parsePromptCatalog。
export function loadPromptCatalog(baseDir: string, locale = DEFAULT_LOCALE): Record<string, string> {
  const fileFor = (loc: string) => (loc === DEFAULT_LOCALE
    ? join(baseDir, 'system_prompt.md')
    : join(baseDir, `system_prompt.${loc}.md`));
  let path = fileFor(locale);
  if (!existsSync(path)) path = fileFor(DEFAULT_LOCALE);
  if (!existsSync(path)) return {};
  return parsePromptCatalog(readFileSync(path, 'utf8'));
}
