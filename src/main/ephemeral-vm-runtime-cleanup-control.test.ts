import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CleanupEphemeralVmRuntimeResult } from './ephemeral-vm-runtime-service'
import {
  runControlledEphemeralVmRuntimeCleanup,
  stopEphemeralVmRuntimeCleanup
} from './ephemeral-vm-runtime-cleanup-control'
import {
  EPHEMERAL_VM_DESTROY_DEADLINE_MS,
  getEphemeralVmDestroyDeadlineMs
} from './ephemeral-vm-destroy-deadline'

afterEach(() => {
  vi.useRealTimers()
})

describe('ephemeral VM runtime cleanup control', () => {
  it('owns one deadline timer per in-flight runtime and clears it on settlement', async () => {
    vi.useFakeTimers()
    let finish: ((result: CleanupEphemeralVmRuntimeResult) => void) | undefined
    let ownedSignal: AbortSignal | undefined
    const run = vi.fn(({ deadlineSignal }: { deadlineSignal: AbortSignal }) => {
      ownedSignal = deadlineSignal
      return new Promise<CleanupEphemeralVmRuntimeResult>((resolve) => {
        finish = resolve
      })
    })
    const args = {
      userDataPath: 'user-data',
      runtimeId: 'runtime-1',
      run
    }

    const first = runControlledEphemeralVmRuntimeCleanup(args)
    const joined = runControlledEphemeralVmRuntimeCleanup(args)

    expect(joined).toBe(first)
    expect(run).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(EPHEMERAL_VM_DESTROY_DEADLINE_MS)
    expect(getEphemeralVmDestroyDeadlineMs(ownedSignal!)).toBe(EPHEMERAL_VM_DESTROY_DEADLINE_MS)
    finish!(failedResult('deadline'))
    await first
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps explicit Stop distinct from deadline expiry', async () => {
    vi.useFakeTimers()
    let ownedSignal: AbortSignal | undefined
    const cleanup = runControlledEphemeralVmRuntimeCleanup({
      userDataPath: 'user-data',
      runtimeId: 'runtime-stop',
      run: ({ signal }) => {
        ownedSignal = signal
        return new Promise<CleanupEphemeralVmRuntimeResult>((resolve) => {
          signal.addEventListener('abort', () => resolve(failedResult('stopped')), { once: true })
        })
      }
    })

    expect(
      stopEphemeralVmRuntimeCleanup({ userDataPath: 'user-data', runtimeId: 'runtime-stop' })
    ).toBe(cleanup)
    await cleanup

    expect(getEphemeralVmDestroyDeadlineMs(ownedSignal!)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still publishes the deadline after Stop when cleanup has not settled', async () => {
    vi.useFakeTimers()
    let finish: ((result: CleanupEphemeralVmRuntimeResult) => void) | undefined
    let signals: { signal: AbortSignal; deadlineSignal: AbortSignal } | undefined
    const cleanup = runControlledEphemeralVmRuntimeCleanup({
      userDataPath: 'user-data',
      runtimeId: 'runtime-stop-deadline',
      run: (ownedSignals) => {
        signals = ownedSignals
        return new Promise<CleanupEphemeralVmRuntimeResult>((resolve) => {
          finish = resolve
        })
      }
    })

    stopEphemeralVmRuntimeCleanup({
      userDataPath: 'user-data',
      runtimeId: 'runtime-stop-deadline'
    })
    expect(signals!.signal.aborted).toBe(true)
    expect(signals!.deadlineSignal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(EPHEMERAL_VM_DESTROY_DEADLINE_MS)
    expect(getEphemeralVmDestroyDeadlineMs(signals!.deadlineSignal)).toBe(
      EPHEMERAL_VM_DESTROY_DEADLINE_MS
    )
    finish!(failedResult('deadline'))
    await cleanup
    expect(vi.getTimerCount()).toBe(0)
  })
})

function failedResult(error: string): CleanupEphemeralVmRuntimeResult {
  return {
    ok: false,
    error,
    runtime: {
      id: 'runtime-1',
      recipeId: 'recipe-1',
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 1,
        connection: {
          type: 'ssh',
          projectRoot: '/workspace/repo',
          target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
        }
      }
    }
  }
}
