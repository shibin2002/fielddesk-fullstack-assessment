import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

export function useLiveUpdates(enabled: boolean): boolean {
  const queryClient = useQueryClient()
  const [live, setLive] = useState(false)

  useEffect(() => {
    if (!enabled) return
    const source = new EventSource('/api/stream')
    let timer = 0
    source.onopen = () => {
      setLive(true)
      void queryClient.invalidateQueries()
    }
    source.onmessage = () => {
      setLive(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void queryClient.invalidateQueries()
      }, 150)
    }
    source.onerror = () => setLive(false)
    return () => {
      window.clearTimeout(timer)
      source.close()
      setLive(false)
    }
  }, [enabled, queryClient])

  return live
}
