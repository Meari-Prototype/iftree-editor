// 命令层装配 context（frontend-refactor.md §4.4 / §4.8 第 2 条）。
//
// 每组命令用 createXxxCommands(deps) 工厂（照 features/library/library-actions.ts 范本）
// 返回方法组；装配根（App.tsx 的 App）组装各组 commands + stores，经此 context 下发。
// 视图用 useCommands().xxx() dispatch、用 stores/use-store.ts 订阅读数据——不直接
// import repository 或 store 单例。领域逻辑下沉纯 TS 命令（不碰 React），React 只留
// DOM/生命周期副作用薄层。
//
import { createContext, useContext } from 'react';

import type { EditorCommands } from './editor-commands.js';
import type { DocumentCommands } from './document-commands.js';
import type { AgentCommands } from './agent-commands.js';
import type { TreeViewCommands } from './treeview-commands.js';
import type { AxiomCommands } from './axiom-commands.js';

export interface AppCommands {
  editor: EditorCommands;
  document: DocumentCommands;
  agent: AgentCommands;
  treeView: TreeViewCommands;
  axiom: AxiomCommands;
  // entity / settings / library 沿用 features 工厂（§4.4），需要时再入驻。
}

export const CommandsContext = createContext<AppCommands | null>(null);

export function useCommands(): AppCommands {
  const value = useContext(CommandsContext);
  if (!value) throw new Error('useCommands must be used within <CommandsContext.Provider>');
  return value;
}
