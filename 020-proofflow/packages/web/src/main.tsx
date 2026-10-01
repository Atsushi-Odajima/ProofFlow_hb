import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from './router.js';
import { App } from './App.js';
import './styles.css';
createRoot(document.getElementById('root')!).render(<StrictMode><RouterProvider><App /></RouterProvider></StrictMode>);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => undefined);
