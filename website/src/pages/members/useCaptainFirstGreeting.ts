import { useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../api/client'

/** Thread slot keys this tab has already asked to greet. Module-level so a
 *  return to Captain (another member in between, a remount) does not ask
 *  again; the server's own once-only marker is what actually guarantees one
 *  greeting, across tabs and reloads. */
const requested = new Set<string>()

/** Test seam: forget what this tab asked, so each test starts clean. */
export function resetCaptainGreetingRequests(): void {
  requested.clear()
}

/**
 * Ask the gateway for Captain's first greeting once its pinned thread is open.
 *
 * `enabled` is true only for the built-in Captain member, and `slotKey` only
 * once the thread endpoint has confirmed it, so the request never races the
 * thread's creation. The server starts a real Captain turn only when that
 * thread is still empty and has never been greeted; every other answer is a
 * no-op here. A failed request is dropped: the chat stays empty and usable.
 */
export function useCaptainFirstGreeting(slug: string | undefined, slotKey: string, enabled: boolean): void {
  const { mutate } = useMutation({ mutationFn: (s: string) => api.memberGreet(s) })
  useEffect(() => {
    if (!enabled || !slug || !slotKey || requested.has(slotKey)) return
    requested.add(slotKey)
    mutate(slug)
  }, [enabled, slug, slotKey, mutate])
}
