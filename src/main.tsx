import React from 'react'
import ReactDOM from 'react-dom/client'

import App from '@/App'
import '@/index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import '@/modules/i18n'

// React Scan is a render-diagnostics overlay, and an expensive one: measured on
// this app it roughly halves the dev frame rate, adds ~14 MB of heap and injects
// a few thousand DOM nodes of its own. It is worth all of that while hunting a
// render bug and worth none of it the rest of the time, so it is opt-in —
// `localStorage.setItem('react-scan', 'on')` and reload.
//
// The import is behind that same flag, not just the overlay: react-scan's browser
// build is ~650 KB and a *static* import put it on every dev first-load's module
// graph (Vite's transform deoptimised its styling for exceeding 500 KB) even in
// the overwhelmingly common case where the flag is off. A dynamic import keeps
// the behaviour identical — flag on: the overlay attaches; flag off: the module is
// never requested — and keeps it out of that graph.
if (import.meta.env.DEV && localStorage.getItem('react-scan') === 'on') {
  void import('react-scan').then(({ scan }) => scan({ enabled: true }))
}

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Unable to mount the app: #root is missing from the document')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
