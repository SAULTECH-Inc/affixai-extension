import React from 'react';
import { createRoot } from 'react-dom/client';
import SigningPage from './signing';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SigningPage />
  </React.StrictMode>
);
