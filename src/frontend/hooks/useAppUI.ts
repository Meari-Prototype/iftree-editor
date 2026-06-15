import { useCallback, useEffect, useMemo, useState } from 'react';

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
