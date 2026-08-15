import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRecipeCommand } from './ephemeral-vm-recipe-process'
import {
  RECIPE_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
  terminateRecipeProcess
} from './ephemeral-vm-recipe-process-termination'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function makeChild(pid: number) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    unref: vi.fn()
  })
}

function setProcessPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  return () => {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

function runWindowsRecipe(
  child: ReturnType<typeof makeChild>,
  args: {
    signal?: AbortSignal
    forceAbortSignal?: AbortSignal
    spawnTreeKiller: ReturnType<typeof vi.fn>
  }
) {
  return runRecipeCommand({
    command: 'destroy',
    repoPath: process.cwd(),
    mode: 'destroy',
    resultSchemaVersion: 1,
    context: { recipeId: 'cloud-sandbox', repoPath: process.cwd() },
    signal: args.signal,
    forceAbortSignal: args.forceAbortSignal,
    spawnCommand: vi.fn(() => child) as never,
    spawnTreeKiller: args.spawnTreeKiller as never
  })
}

describe('terminateRecipeProcess', () => {
  it('waits for a force-killed POSIX process group to disappear', async () => {
    vi.useFakeTimers()
    const child = makeChild(123)
    let livenessChecks = 0
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0 && livenessChecks++ > 0) {
        throw new Error('gone')
      }
      return true
    })

    const termination = terminateRecipeProcess(child as never, true)
    let settled = false
    void termination.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(50)
    await expect(termination).resolves.toBe(true)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('reports a POSIX process group that survives the confirmation window', async () => {
    vi.useFakeTimers()
    const child = makeChild(124)
    vi.spyOn(process, 'kill').mockReturnValue(true)

    const termination = terminateRecipeProcess(child as never, true)
    await vi.advanceTimersByTimeAsync(RECIPE_PROCESS_TREE_TERMINATION_TIMEOUT_MS)

    await expect(termination).resolves.toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a Windows PID that exited before a deadline takeover', async () => {
    const restorePlatform = setProcessPlatform('win32')
    const child = makeChild(125)
    const deadlineController = new AbortController()
    const spawnTreeKiller = vi.fn()
    try {
      const result = runWindowsRecipe(child, {
        forceAbortSignal: deadlineController.signal,
        spawnTreeKiller
      })

      child.emit('exit', 0, null)
      deadlineController.abort()

      await expect(result).resolves.toMatchObject({ aborted: true, terminationFailed: true })
      expect(spawnTreeKiller).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
      expect(child.unref).toHaveBeenCalledOnce()
    } finally {
      restorePlatform()
    }
  })

  it('preserves the Windows wrapper after graceful taskkill fails', async () => {
    const restorePlatform = setProcessPlatform('win32')
    const child = makeChild(126)
    const gracefulKiller = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() })
    const forceKiller = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() })
    const spawnTreeKiller = vi
      .fn()
      .mockReturnValueOnce(gracefulKiller)
      .mockReturnValueOnce(forceKiller)
    const stopController = new AbortController()
    const deadlineController = new AbortController()
    try {
      const result = runWindowsRecipe(child, {
        signal: stopController.signal,
        forceAbortSignal: deadlineController.signal,
        spawnTreeKiller
      })

      stopController.abort()
      gracefulKiller.emit('close', 1, null)
      expect(child.kill).not.toHaveBeenCalled()
      deadlineController.abort()
      expect(spawnTreeKiller).toHaveBeenNthCalledWith(2, 'taskkill', ['/pid', '126', '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      forceKiller.emit('close', 0, null)

      await expect(result).resolves.toMatchObject({ aborted: true })
      expect(child.kill).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })
})
