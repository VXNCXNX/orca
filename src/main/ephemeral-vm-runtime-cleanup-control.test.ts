import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CleanupEphemeralVmRuntimeResult } from './ephemeral-vm-runtime-service'
import {
  getEphemeralVmRuntimeCleanupDeadlineMs,
  runControlledEphemeralVmRuntimeCleanup,
  stopEphemeralVmRuntimeCleanup
} from './ephemeral-vm-runtime-cleanup-control'

afterEach(() => {
  vi.useRealTimers()
})

describe('ephemeral VM runtime cleanup control', () => {
  it('owns one deadline timer per in-flight runtime and clears it on settlement', async () => {
    vi.useFakeTimers()
    let finish: ((result: CleanupEphemeralVmRuntimeResult) => void) | undefined
    let ownedSignal: AbortSignal | undefined
    const run = vi.fn((signal: AbortSignal) => {
      ownedSignal = signal
      return new Promise<CleanupEphemeralVmRuntimeResult>((resolve) => {
        finish = resolve
      })
    })
    const args = {
      userDataPath: '/user-data',
      runtimeId: 'runtime-1',
      deadlineMs: 100,
      run
    }

    const first = runControlledEphemeralVmRuntimeCleanup(args)
    const joined = runControlledEphemeralVmRuntimeCleanup({ ...args, deadlineMs: 1_000 })

    expect(joined).toBe(first)
    expect(run).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(getEphemeralVmRuntimeCleanupDeadlineMs(ownedSignal!)).toBe(100)
    finish!(failedResult('deadline'))
    await first
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps explicit Stop distinct from deadline expiry', async () => {
    vi.useFakeTimers()
    let ownedSignal: AbortSignal | undefined
    const cleanup = runControlledEphemeralVmRuntimeCleanup({
      userDataPath: '/user-data',
      runtimeId: 'runtime-stop',
      deadlineMs: 100,
      run: (signal) => {
        ownedSignal = signal
        return new Promise<CleanupEphemeralVmRuntimeResult>((resolve) => {
          signal.addEventListener('abort', () => resolve(failedResult('stopped')), { once: true })
        })
      }
    })

    expect(
      stopEphemeralVmRuntimeCleanup({ userDataPath: '/user-data', runtimeId: 'runtime-stop' })
    ).toBe(cleanup)
    await cleanup

    expect(getEphemeralVmRuntimeCleanupDeadlineMs(ownedSignal!)).toBeNull()
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
