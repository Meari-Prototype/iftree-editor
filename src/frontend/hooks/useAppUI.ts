// @ts-nocheck
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// UI 横切 context：包住 useAppUI 的全部产物（busy/notice/progress/operationLock/
// lockedProgress/activeTab/activeScreen + 对应 setter + lock/unlock）。App 顶部
// useAppUI() 拿到 value，用 <AppUIContext.Provider value={ui}> 喂给子树；下游
// hook/组件用 useAppUIContext() 直接读，省掉 props 透传链。App 内部编排函数仍用
// 解构 const，不进 context。action 工厂（createLibraryActions/openSettingsAction）
// 是纯函数非 hook，保留入参传法。
export const AppUIContext = createContext<any>(null);

export function useAppUIContext() {
  const value = useContext(AppUIContext);
  if (!value) throw new Error('useAppUIContext must be used within <AppUIContext.Provider>');
  return value;
}

export function useAppUI() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [activeTab, setActiveTab] = useState('tree');
  const [progress, setProgress] = useState(null);
  const [operationLock, setOperationLock] = useState(null);
  const [activeScreen, setActiveScreen] = useState('editor');

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => {
      setNotice((current) => (current === notice ? '' : current));
    }, 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const lock = useCallback((label, options = {}) => {
    if (label && typeof label === 'object') {
      setOperationLock({ step: 0, total: 0, ...label });
      return;
    }
    setOperationLock({ label, step: 0, total: 0, ...options });
  }, []);

  const unlock = useCallback(() => {
    setOperationLock(null);
    setProgress(null);
  }, []);

  const lockedProgress = useMemo(() => (
    operationLock
      ? {
          ...(progress || {}),
          ...operationLock,
          label: progress?.label || operationLock.label,
          step: Number(progress?.step ?? operationLock.step ?? 0),
          total: Number(progress?.total ?? operationLock.total ?? 0)
        }
      : null
  ), [operationLock, progress]);

  return useMemo(() => ({
    busy,
    notice,
    progress,
    operationLock,
    lockedProgress,
    activeTab,
    activeScreen,
    setBusy,
    setNotice,
    setProgress,
    setOperationLock,
    setActiveTab,
    setActiveScreen,
    lock,
    unlock
  }), [
    activeScreen,
    activeTab,
    busy,
    lock,
    lockedProgress,
    notice,
    operationLock,
    progress,
    unlock
  ]);
}
