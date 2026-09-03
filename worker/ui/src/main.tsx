import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import VersionArchive from '@/components/version-archive';
import '@/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <VersionArchive />
  </StrictMode>
);
