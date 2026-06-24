import { useAppUI, AppUIContext } from './hooks/useAppUI.js';
import { AppBody } from './AppBody.js';

export function App() {
  const ui = useAppUI();
  return (
    <AppUIContext.Provider value={ui}>
      <AppBody />
    </AppUIContext.Provider>
  );
}