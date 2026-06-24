import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '../frontend/App.js';
import { EntityMaintenanceWindow } from '../frontend/components/EntityMaintenanceWindow.js';
import '../frontend/styles.css';

function Root() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('screen') === 'entity-maintenance') return <EntityMaintenanceWindow />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
