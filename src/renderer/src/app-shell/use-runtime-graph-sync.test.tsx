// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  scheduleRuntimeGraphSync: vi.fn(),
  setRuntimeGraphStoreStateGetter: vi.fn(),
  setRuntimeGraphSyncEnabled: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  unsubscribeReadiness: vi.fn(),
  readinessListener: null as (() => void) | null
}))

vi.mock('../runtime/sync-runtime-graph', () => ({
  canSkipRuntimeMobileSessionSyncKeyBuild: vi.fn(() => true),
  getRuntimeMobileSessionSyncKey: vi.fn(() => ({ systemPrefersDark: false })),
  runtimeMobileSessionSyncKeysEqual: vi.fn(() => true),
  scheduleRuntimeGraphSync: mocks.scheduleRuntimeGraphSync,
  setRuntimeGraphStoreStateGetter: mocks.setRuntimeGraphStoreStateGetter,
  setRuntimeGraphSyncEnabled: mocks.setRuntimeGraphSyncEnabled
}))

vi.mock('../store', () => {
  const state = { workspaceSessionReady: true }
  const useAppStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state, subscribe: mocks.subscribe }
  )
  return { useAppStore }
})

import { useRuntimeGraphSync } from './use-runtime-graph-sync'

describe('useRuntimeGraphSync orchestration readiness', () => {
  beforeEach(() => {
    mocks.readinessListener = null
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtime: {
          onOrchestrationReady: (listener: () => void) => {
            mocks.readinessListener = listener
            return mocks.unsubscribeReadiness
          }
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('requests one coalesced graph publication after readiness becomes true', () => {
    const hook = renderHook(() => useRuntimeGraphSync())

    act(() => mocks.readinessListener?.())

    expect(mocks.scheduleRuntimeGraphSync).toHaveBeenCalledTimes(1)
    hook.unmount()
    expect(mocks.unsubscribeReadiness).toHaveBeenCalledTimes(1)
  })
})
