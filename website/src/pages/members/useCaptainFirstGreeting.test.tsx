import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../api/client', () => ({
  api: { memberGreet: vi.fn(() => Promise.resolve({ outcome: 'started' })) },
}))

import { api } from '../../api/client'
import { resetCaptainGreetingRequests, useCaptainFirstGreeting } from './useCaptainFirstGreeting'

/* The page-side trigger of Captain's first greeting. The server owns the
 * once-only guarantee; this hook only has to ask at the right moment (Captain,
 * confirmed thread) and not ask again for the same thread in this tab. */

const greet = api.memberGreet as ReturnType<typeof vi.fn>

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  vi.clearAllMocks()
  resetCaptainGreetingRequests()
})

describe('useCaptainFirstGreeting', () => {
  it('asks once the Captain thread is confirmed', async () => {
    renderHook(() => useCaptainFirstGreeting('kirocrew-captain', 'member-kirocrew-captain', true), { wrapper })
    await waitFor(() => expect(greet).toHaveBeenCalledWith('kirocrew-captain'))
    expect(greet).toHaveBeenCalledTimes(1)
  })

  it('never asks for another crewmate', async () => {
    renderHook(() => useCaptainFirstGreeting('alpha', 'member-alpha', false), { wrapper })
    await new Promise((r) => setTimeout(r, 0))
    expect(greet).not.toHaveBeenCalled()
  })

  it('waits for the confirmed slot key before asking', async () => {
    const { rerender } = renderHook(
      ({ slot }: { slot: string }) => useCaptainFirstGreeting('kirocrew-captain', slot, true),
      { wrapper, initialProps: { slot: '' } },
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(greet).not.toHaveBeenCalled()
    rerender({ slot: 'member-kirocrew-captain' })
    await waitFor(() => expect(greet).toHaveBeenCalledTimes(1))
  })

  it('does not ask again for the same thread after a remount in this tab', async () => {
    const first = renderHook(() => useCaptainFirstGreeting('kirocrew-captain', 'member-kirocrew-captain', true), { wrapper })
    await waitFor(() => expect(greet).toHaveBeenCalledTimes(1))
    first.unmount()
    renderHook(() => useCaptainFirstGreeting('kirocrew-captain', 'member-kirocrew-captain', true), { wrapper })
    await new Promise((r) => setTimeout(r, 0))
    expect(greet).toHaveBeenCalledTimes(1)
  })

  it('a failed request is dropped quietly', async () => {
    greet.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useCaptainFirstGreeting('kirocrew-captain', 'member-kirocrew-captain', true), { wrapper })
    await waitFor(() => expect(greet).toHaveBeenCalledTimes(1))
    expect(result.current).toBeUndefined()
  })
})
