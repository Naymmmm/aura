import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import VersionArchive from '@/components/version-archive';
import AdminPage from '@/components/admin-page';
import '@/index.css';

const path = window.location.pathname;
const page = path.startsWith('/admin') ? <AdminPage /> : <VersionArchive />;

createRoot(document.getElementById('root')!).render(<StrictMode>{page}</StrictMode>);
