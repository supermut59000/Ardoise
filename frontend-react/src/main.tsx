import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from 'next-themes'
import './index.css'
import App from './App.tsx'
import { ThemedToaster } from '@/components/ui/sonner'
import { requestPersistentStorage } from '@/lib/persist'

// Data is local-first via Dexie's live queries (no react-query needed).
// The service worker is registered by <PwaPrompt/> (so it can also prompt for updates).
void requestPersistentStorage()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" storageKey="ardoise-theme" disableTransitionOnChange>
      <BrowserRouter>
        <App />
        <ThemedToaster />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
)
