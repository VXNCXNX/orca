import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EPHEMERAL_VM_CLEANUP_TERMINATION_UNCONFIRMED_ERROR,
  getEphemeralVmRecipeDestroyFailure
} from './ephemeral-vm-recipe-destroy-result'
import { runRecipeCommand } from './ephemeral-vm-recipe-process'

const tmpRoots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-vm-recipe-process-'))
  tmpRoots.push(root)
  return root
}

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

describe('runRecipeCommand', () => {
  it('does not impose an implicit wall-clock deadline', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn()
    })
    const resultPromise = runRecipeCommand({
      command: 'destroy',
      repoPath: makeRepo(),
      mode: 'destroy',
      resultSchemaVersion: 1,
      context: { recipeId: 'cloud-sandbox', repoPath: makeRepo() },
      spawnCommand: vi.fn(() => child) as never
    })

    expect(vi.getTimerCount()).toBe(0)
    child.emit('close', 0, null)
    await expect(resultPromise).resolves.toMatchObject({ exitCode: 0 })
  })

  it('force-kills an aborted recipe if graceful termination never closes it', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn()
    })
    const controller = new AbortController()
    const resultPromise = runRecipeCommand({
      command: 'destroy',
      repoPath: makeRepo(),
      mode: 'destroy',
      resultSchemaVersion: 1,
      context: { recipeId: 'cloud-sandbox', repoPath: makeRepo() },
      signal: controller.signal,
      spawnCommand: vi.fn(() => child) as never
    })

    controller.abort()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(resultPromise).resolves.toMatchObject({ aborted: true, exitCode: null })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('force-kills and settles immediately when a deadline signal aborts', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn()
    })
    const controller = new AbortController()
    const resultPromise = runRecipeCommand({
      command: 'destroy',
      repoPath: makeRepo(),
      mode: 'destroy',
      resultSchemaVersion: 1,
      context: { recipeId: 'cloud-sandbox', repoPath: makeRepo() },
      forceAbortSignal: controller.signal,
      spawnCommand: vi.fn(() => child) as never
    })

    controller.abort()

    await expect(resultPromise).resolves.toMatchObject({ aborted: true, exitCode: null })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(child.unref).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for Windows taskkill before deadline settlement', async () => {
    vi.useFakeTimers()
    const restorePlatform = setProcessPlatform('win32')
    const child = Object.assign(new EventEmitter(), {
      pid: 321,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn()
    })
    const killer = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() })
    const spawnTreeKiller = vi.fn(() => killer)
    const controller = new AbortController()
    try {
      const resultPromise = runRecipeCommand({
        command: 'destroy',
        repoPath: makeRepo(),
        mode: 'destroy',
        resultSchemaVersion: 1,
        context: { recipeId: 'cloud-sandbox', repoPath: makeRepo() },
        forceAbortSignal: controller.signal,
        spawnCommand: vi.fn(() => child) as never,
        spawnTreeKiller: spawnTreeKiller as never
      })

      controller.abort()
      let settled = false
      void resultPromise.then(() => {
        settled = true
      })
      await Promise.resolve()

      expect(settled).toBe(false)
      expect(spawnTreeKiller).toHaveBeenCalledWith('taskkill', ['/pid', '321', '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.emit('close', 0, null)
      await expect(resultPromise).resolves.not.toHaveProperty('terminationFailed')
      expect(child.unref).toHaveBeenCalledOnce()
    } finally {
      restorePlatform()
    }
  })

  it('reports an unconfirmed Windows tree kill and falls back to the wrapper', async () => {
    vi.useFakeTimers()
    const restorePlatform = setProcessPlatform('win32')
    const child = Object.assign(new EventEmitter(), {
      pid: 654,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn()
    })
    const killer = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() })
    const controller = new AbortController()
    try {
      const resultPromise = runRecipeCommand({
        command: 'destroy',
        repoPath: makeRepo(),
        mode: 'destroy',
        resultSchemaVersion: 1,
        context: { recipeId: 'cloud-sandbox', repoPath: makeRepo() },
        forceAbortSignal: controller.signal,
        spawnCommand: vi.fn(() => child) as never,
        spawnTreeKiller: vi.fn(() => killer) as never
      })

      controller.abort()
      killer.emit('close', 1, null)

      await expect(resultPromise).resolves.toMatchObject({ terminationFailed: true })
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      restorePlatform()
    }
  })

  it('bounds an unresponsive Windows tree killer', async () => {
    vi.useFakeTimers()
    const restorePlatform = setProcessPlatform('win32')
    const child = Object.assign(new EventEmitter(), {
      pid: 765,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn()
    })
    const killer = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() })
    const controller = new AbortController()
    try {
      const resultPromise = runRecipeCommand({
        command: 'destroy',
        repoPath: makeRepo(),
        mode: 'destroy',
        resultSchemaVersion: 1,
        context: { recipeId: 'cloud-sandbox', repoPath: makeRepo() },
        forceAbortSignal: controller.signal,
        spawnCommand: vi.fn(() => child) as never,
        spawnTreeKiller: vi.fn(() => killer) as never
      })

      controller.abort()
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(resultPromise).resolves.toMatchObject({ terminationFailed: true })
      expect(killer.kill).toHaveBeenCalledWith('SIGKILL')
      expect(killer.unref).toHaveBeenCalledOnce()
      expect(killer.listenerCount('close')).toBe(0)
      expect(() => killer.emit('error', new Error('late kill error'))).not.toThrow()
      expect(killer.listenerCount('error')).toBe(0)
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      restorePlatform()
    }
  })

  it('omits Windows force mode for explicit Stop', async () => {
    vi.useFakeTimers()
    const restorePlatform = setProcessPlatform('win32')
    const child = Object.assign(new EventEmitter(), {
      pid: 987,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn()
    })
    const killer = Object.assign(new EventEmitter(), { kill: vi.fn() })
    const spawnTreeKiller = vi.fn(() => killer)
    const controller = new AbortController()
    try {
      const resultPromise = runRecipeCommand({
        command: 'destroy',
        repoPath: makeRepo(),
        mode: 'destroy',
        resultSchemaVersion: 1,
        context: { recipeId: 'cloud-sandbox', repoPath: makeRepo() },
        signal: controller.signal,
        spawnCommand: vi.fn(() => child) as never,
        spawnTreeKiller: spawnTreeKiller as never
      })

      controller.abort()
      expect(spawnTreeKiller).toHaveBeenCalledWith('taskkill', ['/pid', '987', '/t'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.emit('close', 0, null)
      child.emit('close', null, 'SIGTERM')
      await expect(resultPromise).resolves.toMatchObject({ aborted: true, signal: 'SIGTERM' })
    } finally {
      restorePlatform()
    }
  })

  it('force-escalates a Windows Stop when the total deadline arrives', async () => {
    vi.useFakeTimers()
    const restorePlatform = setProcessPlatform('win32')
    const child = Object.assign(new EventEmitter(), {
      pid: 988,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn()
    })
    const gracefulKiller = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() })
    const forceKiller = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() })
    const spawnTreeKiller = vi
      .fn()
      .mockReturnValueOnce(gracefulKiller)
      .mockReturnValueOnce(forceKiller)
    const stopController = new AbortController()
    const deadlineController = new AbortController()
    try {
      const resultPromise = runRecipeCommand({
        command: 'destroy',
        repoPath: makeRepo(),
        mode: 'destroy',
        resultSchemaVersion: 1,
        context: { recipeId: 'cloud-sandbox', repoPath: makeRepo() },
        signal: stopController.signal,
        forceAbortSignal: deadlineController.signal,
        spawnCommand: vi.fn(() => child) as never,
        spawnTreeKiller: spawnTreeKiller as never
      })

      stopController.abort()
      deadlineController.abort()

      expect(gracefulKiller.kill).toHaveBeenCalledWith('SIGKILL')
      expect(gracefulKiller.unref).toHaveBeenCalledOnce()
      expect(spawnTreeKiller).toHaveBeenNthCalledWith(2, 'taskkill', ['/pid', '988', '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      expect(child.kill).not.toHaveBeenCalled()
      forceKiller.emit('close', 0, null)
      await expect(resultPromise).resolves.toMatchObject({ aborted: true })
    } finally {
      restorePlatform()
    }
  })

  it('does not force-kill a stale Windows PID after its owned shell closes', async () => {
    vi.useFakeTimers()
    const restorePlatform = setProcessPlatform('win32')
    const child = Object.assign(new EventEmitter(), {
      pid: 989,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn()
    })
    const gracefulKiller = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn() })
    const spawnTreeKiller = vi.fn(() => gracefulKiller)
    const stopController = new AbortController()
    const deadlineController = new AbortController()
    try {
      const resultPromise = runRecipeCommand({
        command: 'destroy',
        repoPath: makeRepo(),
        mode: 'destroy',
        resultSchemaVersion: 1,
        context: { recipeId: 'cloud-sandbox', repoPath: makeRepo() },
        signal: stopController.signal,
        forceAbortSignal: deadlineController.signal,
        spawnCommand: vi.fn(() => child) as never,
        spawnTreeKiller: spawnTreeKiller as never
      })

      stopController.abort()
      child.emit('close', null, 'SIGTERM')
      deadlineController.abort()
      expect(spawnTreeKiller).toHaveBeenCalledOnce()

      gracefulKiller.emit('close', 1, null)
      await expect(resultPromise).resolves.toMatchObject({
        aborted: true,
        terminationFailed: true
      })
      expect(spawnTreeKiller).toHaveBeenCalledOnce()
    } finally {
      restorePlatform()
    }
  })

  it('reports an unconfirmed stopped process tree as actionable', () => {
    expect(
      getEphemeralVmRecipeDestroyFailure({
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        aborted: true,
        terminationFailed: true
      })
    ).toMatchObject({ error: EPHEMERAL_VM_CLEANUP_TERMINATION_UNCONFIRMED_ERROR })
  })

  it('clears the force-kill timer when graceful termination closes synchronously', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn()
    })
    child.kill.mockImplementation(() => {
      child.emit('close', null, 'SIGTERM')
      return true
    })
    const controller = new AbortController()
    const resultPromise = runRecipeCommand({
      command: 'destroy',
      repoPath: makeRepo(),
      mode: 'destroy',
      resultSchemaVersion: 1,
      context: { recipeId: 'cloud-sandbox', repoPath: makeRepo() },
      signal: controller.signal,
      spawnCommand: vi.fn(() => child) as never
    })

    controller.abort()

    await expect(resultPromise).resolves.toMatchObject({ aborted: true, signal: 'SIGTERM' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { output: 'abcdef', maxCaptureBytes: 4, expected: 'cdef' },
    { output: 'A😀B', maxCaptureBytes: 5, expected: '😀B' },
    { output: '😀😀😀', maxCaptureBytes: 5, expected: '😀' }
  ])(
    'retains a complete UTF-8 tail within $maxCaptureBytes bytes',
    async ({ output, maxCaptureBytes, expected }) => {
      const repoPath = makeRepo()
      const scriptPath = join(repoPath, 'output.js')
      writeFileSync(scriptPath, `process.stdout.write(${JSON.stringify(output)})`)

      const result = await runRecipeCommand({
        command: nodeCommand(scriptPath),
        repoPath,
        mode: 'create',
        resultSchemaVersion: 1,
        context: {
          recipeId: 'cloud-sandbox',
          repoPath
        },
        maxCaptureBytes
      })

      expect(result.stdout).toBe(expected)
      expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(maxCaptureBytes)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'cancels shell child processes without waiting for long-running descendants',
    async () => {
      const repoPath = makeRepo()
      const scriptPath = join(repoPath, 'slow.js')
      writeFileSync(
        scriptPath,
        [
          "process.stderr.write('ready\\n')",
          'setTimeout(() => {',
          "  console.log('done')",
          '}, 5000)'
        ].join('\n')
      )
      const controller = new AbortController()

      const result = await Promise.race([
        runRecipeCommand({
          command: nodeCommand(scriptPath),
          repoPath,
          mode: 'create',
          resultSchemaVersion: 1,
          context: {
            recipeId: 'cloud-sandbox',
            repoPath
          },
          signal: controller.signal,
          onStderr: (chunk) => {
            if (chunk.includes('ready')) {
              controller.abort()
            }
          }
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('recipe cancellation timed out')), 1500)
        })
      ])

      expect(result).toMatchObject({ signal: 'SIGTERM', aborted: true })
    }
  )
})

function setProcessPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  return () => {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}
