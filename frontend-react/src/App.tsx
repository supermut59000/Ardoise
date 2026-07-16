import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Groups } from '@/pages/Groups'
import { GroupDetail } from '@/pages/GroupDetail'
import { ExpenseForm } from '@/pages/ExpenseForm'
import { SyncBar } from '@/components/layout/SyncBar'
import { PwaPrompt } from '@/components/layout/PwaPrompt'
import { ApiKeyDialog } from '@/components/layout/ApiKeyDialog'
import { ErrorBoundary } from '@/components/layout/ErrorBoundary'
import { useSync } from '@/hooks/use-sync'
import { AUTH_REQUIRED_EVENT } from '@/lib/auth'
import { syncPushGroups } from '@/lib/push'

function App() {
  const { online, syncing, pending } = useSync()
  const [authOpen, setAuthOpen] = useState(false)

  // Any sync request that needs the password dispatches this event.
  useEffect(() => {
    const open = () => setAuthOpen(true)
    window.addEventListener(AUTH_REQUIRED_EVENT, open)
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, open)
  }, [])

  // Keep the server's notification group list in step with this device
  // (no-op unless notifications are enabled here).
  useEffect(() => {
    void syncPushGroups()
  }, [])

  return (
    <>
      <PwaPrompt />
      <SyncBar online={online} syncing={syncing} pending={pending} />
      {/* A page crash degrades to a French fallback + reload, never a white screen. */}
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Groups />} />
          <Route path="/g/:groupId" element={<GroupDetail />} />
          <Route path="/g/:groupId/add" element={<ExpenseForm />} />
          <Route path="/g/:groupId/e/:expenseId" element={<ExpenseForm />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
      <ApiKeyDialog open={authOpen} onOpenChange={setAuthOpen} />
    </>
  )
}

export default App
