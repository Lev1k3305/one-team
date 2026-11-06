import {createRoot} from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);

// Register Service Worker for PWA with update detection and safe activation only in Web/PWA
if (!Capacitor.isNativePlatform() && 'serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        // Detect updates
        registration.addEventListener('updatefound', () => {
          const installingWorker = registration.installing;
          if (!installingWorker) return;

          installingWorker.addEventListener('statechange', () => {
            if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
              window.dispatchEvent(
                new CustomEvent('oneteam:pwa-update-available', {
                  detail: { registration },
                })
              );
            }
          });
        });
      })
      .catch((error) => {
        console.error('ServiceWorker registration error:', error);
      });
  });
}
