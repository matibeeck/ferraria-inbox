'use client'

import { useEffect } from 'react'
import posthog from 'posthog-js'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN && process.env.NEXT_PUBLIC_POSTHOG_HOST) {
      posthog.captureException(error)
    }
  }, [error])

  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 24,
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: 20, margin: 0 }}>Algo salió mal</h1>
        <p style={{ margin: 0 }}>Recarga la página para seguir trabajando.</p>
        <button
          type="button"
          onClick={reset}
          style={{ padding: '10px 20px', fontSize: 16, borderRadius: 8, border: '1px solid #ccc', cursor: 'pointer' }}
        >
          Reintentar
        </button>
      </body>
    </html>
  )
}
