import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EPHEMERAL_VM_CLEANUP_TERMINATION_UNCONFIRMED_ERROR } from '../shared/ephemeral-vm-recipe-destroy-result'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import { EPHEMERAL_VM_DESTROY_DEADLINE_MS } from './ephemeral-vm-destroy-deadline'

const { runCleanupMock } = vi.hoisted(() => ({ runCleanupMock: vi.fn() }))

vi.mock('./ephemeral-vm-recipe-runner', () => ({
  runEphemeralVmRecipeCleanup: runCleanupMock
}))

import { cleanupFailedEphemeralVmStart } from './ephemeral-vm-failed-start-cleanup'

let tempDir: string

beforeEach(() => {
  vi.useFakeTimers()
  tempDir = mkdtempSync(join(tmpdir(), 'orca-vm-failed-start-cleanup-'))
  runCleanupMock.mockReset().mockImplementation(
    ({ forceAbortSignal }: { forceAbortSignal: AbortSignal }) =>
      new Promise((resolve) => {
        forceAbortSignal.addEventListener(
          'abort',
          () =>
            resolve({
              ok: false,
              skipped: false,
              error: 'Cleanup stopped by user.',
              stdout: '',
              stderr: '',
              exitCode: null,
              signal: null,
              aborted: true
            }),
          { once: true }
        )
      })
  )
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(tempDir, { recursive: true, force: true })
})

it('bounds failed-start destroy and persists actionable recovery', async () => {
  const cleanup = cleanupFailedEphemeralVmStart(
    {
      userDataPath: tempDir,
      repoPath: tempDir,
      recipe: {
        id: 'cloud-sandbox',
        name: 'Cloud Sandbox',
        create: 'unused',
        destroy: 'never-exits'
      },
      repoId: 'repo-1',
      now: 1_000
    },
    {
      context: {
        instanceId: 'runtime-failed-start',
        recipeId: 'cloud-sandbox',
        repoPath: tempDir
      },
      recipeResult: {
        schemaVersion: 1,
        connection: {
          type: 'ssh',
          projectRoot: '/workspace/repo',
          target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
        }
      }
    }
  )

  await vi.advanceTimersByTimeAsync(EPHEMERAL_VM_DESTROY_DEADLINE_MS)

  await expect(cleanup).resolves.toBe(false)
  expect(listEphemeralVmRuntimes(tempDir)).toEqual([
    expect.objectContaining({
      id: 'runtime-failed-start',
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      cleanupLastError: expect.stringContaining('5-minute deadline')
    })
  ])
  expect(vi.getTimerCount()).toBe(0)
})

it('persists unconfirmed stopped-tree recovery after a failed start', async () => {
  runCleanupMock.mockResolvedValue({
    ok: false,
    skipped: false,
    error: EPHEMERAL_VM_CLEANUP_TERMINATION_UNCONFIRMED_ERROR,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    aborted: true,
    terminationFailed: true
  })

  await cleanupFailedEphemeralVmStart(
    {
      userDataPath: tempDir,
      repoPath: tempDir,
      recipe: {
        id: 'cloud-sandbox',
        name: 'Cloud Sandbox',
        create: 'unused',
        destroy: 'failed-tree-kill'
      },
      now: 2_000
    },
    {
      context: {
        instanceId: 'runtime-unconfirmed-stop',
        recipeId: 'cloud-sandbox',
        repoPath: tempDir
      },
      recipeResult: {
        schemaVersion: 1,
        connection: {
          type: 'ssh',
          projectRoot: '/workspace/repo',
          target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
        }
      }
    }
  )

  expect(listEphemeralVmRuntimes(tempDir)).toEqual([
    expect.objectContaining({
      id: 'runtime-unconfirmed-stop',
      cleanupLastError: EPHEMERAL_VM_CLEANUP_TERMINATION_UNCONFIRMED_ERROR
    })
  ])
  expect(vi.getTimerCount()).toBe(0)
})
