import { useTheme } from 'next-themes'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

/** Sonner toaster that follows the app's light/dark theme. */
export function ThemedToaster(props: ToasterProps) {
  const { theme = 'system' } = useTheme()
  return <Sonner theme={theme as ToasterProps['theme']} position="top-center" richColors {...props} />
}
