import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { EphemeralVmRecipeContext } from './ephemeral-vm-recipe-runner'

const DEFAULT_MAX_CAPTURE_BYTES = 1024 * 1024
const CANCEL_FORCE_KILL_DELAY_MS = 5_000
export const RECIPE_PROCESS_TREE_TERMINATION_TIMEOUT_MS = 5_000

export type ProcessRunResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  aborted?: true
  terminationFailed?: true
}

export function quoteShellToken(value: string): string {
  if (process.platform === 'win32') {
    // Inside cmd.exe double quotes, `^` is literal; an embedded `"` is escaped
    // by doubling it. This token is only displayed for manual cleanup, so it
    // must be valid when pasted into cmd.exe.
    return `"${value.replace(/"/g, '""')}"`
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function runRecipeCommand(args: {
  command: string
  repoPath: string
  context: EphemeralVmRecipeContext
  mode: 'create' | 'suspend' | 'resume' | 'destroy'
  resultSchemaVersion: 1 | 2
  stdin?: string
  env?: NodeJS.ProcessEnv
  maxCaptureBytes?: number
  signal?: AbortSignal
  forceAbortSignal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  spawnCommand?: typeof spawn
  spawnTreeKiller?: typeof spawn
}): Promise<ProcessRunResult> {
  const maxBytes = args.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES
  const spawnCommand = args.spawnCommand ?? spawn

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnCommand(args.command, {
        cwd: args.repoPath,
        detached: process.platform !== 'win32',
        env: buildRecipeEnv(args.env, args.mode, args.context, args.resultSchemaVersion),
        shell: true,
        windowsHide: true
      }) as ChildProcessWithoutNullStreams
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let aborted = false
    let forceAborting = false
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: ProcessRunResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      args.signal?.removeEventListener('abort', abort)
      args.forceAbortSignal?.removeEventListener('abort', forceAbort)
      resolve(result)
    }
    const fail = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      args.signal?.removeEventListener('abort', abort)
      args.forceAbortSignal?.removeEventListener('abort', forceAbort)
      reject(error)
    }
    const forceAbort = (): void => {
      if (settled || forceAborting) {
        return
      }
      forceAborting = true
      aborted = true
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      void terminateRecipeProcess(child, true, args.spawnTreeKiller).then((confirmed) => {
        finish({
          stdout,
          stderr,
          exitCode: null,
          signal: null,
          aborted: true,
          ...(!confirmed ? { terminationFailed: true as const } : {})
        })
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
      })
    }
    const abort = (): void => {
      if (settled || forceAborting) {
        return
      }
      aborted = true
      forceKillTimer = setTimeout(() => {
        if (settled) {
          return
        }
        forceAbort()
      }, CANCEL_FORCE_KILL_DELAY_MS)
      forceKillTimer.unref()
      void terminateRecipeProcess(child, false, args.spawnTreeKiller)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk, maxBytes)
      args.onStdout?.(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBounded(stderr, chunk, maxBytes)
      args.onStderr?.(chunk)
    })
    child.on('error', (error) => {
      if (forceAborting) {
        return
      }
      fail(error)
    })
    child.on('close', (exitCode, signal) => {
      if (forceAborting) {
        return
      }
      finish({ stdout, stderr, exitCode, signal, ...(aborted ? { aborted: true } : {}) })
    })

    if (args.forceAbortSignal?.aborted) {
      forceAbort()
    } else {
      args.forceAbortSignal?.addEventListener('abort', forceAbort, { once: true })
    }
    if (!forceAborting && args.signal?.aborted) {
      abort()
    } else if (!forceAborting) {
      args.signal?.addEventListener('abort', abort, { once: true })
    }

    if (forceAborting) {
      return
    }
    if (args.stdin) {
      child.stdin.end(args.stdin)
    } else {
      child.stdin.end()
    }
  })
}

function terminateRecipeProcess(
  child: ChildProcessWithoutNullStreams,
  force: boolean,
  spawnTreeKiller = spawn
): Promise<boolean> {
  const signal = force ? 'SIGKILL' : 'SIGTERM'
  if (process.platform === 'win32') {
    if (child.pid) {
      return terminateWindowsRecipeProcess(child, signal, force, spawnTreeKiller)
    }
    child.kill(signal)
    return Promise.resolve(false)
  }
  if (child.pid) {
    try {
      // Recipes run through a shell; kill the process group so shell children do not linger.
      process.kill(-child.pid, signal)
      return Promise.resolve(true)
    } catch {
      // Fall back to killing the direct child if the process group is already gone.
    }
  }
  child.kill(signal)
  return Promise.resolve(false)
}

function terminateWindowsRecipeProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
  force: boolean,
  spawnTreeKiller: typeof spawn
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let killer: ReturnType<typeof spawn>
    const finish = (confirmed: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (!confirmed) {
        child.kill(signal)
      }
      resolve(confirmed)
    }
    try {
      killer = spawnTreeKiller(
        'taskkill',
        ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])],
        { windowsHide: true, stdio: 'ignore' }
      )
    } catch {
      child.kill(signal)
      resolve(false)
      return
    }
    const timeout = setTimeout(() => {
      killer.kill('SIGKILL')
      finish(false)
    }, RECIPE_PROCESS_TREE_TERMINATION_TIMEOUT_MS)
    timeout.unref()
    killer.once('error', () => finish(false))
    killer.once('close', (exitCode) => finish(exitCode === 0))
  })
}

function buildRecipeEnv(
  env: NodeJS.ProcessEnv | undefined,
  mode: 'create' | 'suspend' | 'resume' | 'destroy',
  context: EphemeralVmRecipeContext,
  resultSchemaVersion: 1 | 2
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
    ORCA_VM_MODE: mode,
    ORCA_VM_INSTANCE_ID: context.instanceId ?? '',
    ORCA_RECIPE_ID: context.recipeId,
    ORCA_PROJECT_ID: context.projectId ?? '',
    ORCA_WORKSPACE_ID: context.workspaceId ?? '',
    ORCA_WORKSPACE_NAME: context.workspaceName ?? '',
    ORCA_REPO_PATH: context.repoPath,
    ORCA_REPO_URL: context.repoUrl ?? '',
    ORCA_REPO_BRANCH: context.branch ?? '',
    ORCA_REPO_REF: context.ref ?? '',
    ORCA_REPO_REF_HEAD: context.expectedRefHead ?? '',
    ORCA_RECIPE_RESULT_SCHEMA_VERSION: String(resultSchemaVersion),
    ORCA_VERSION: context.orcaVersion ?? ''
  }
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return ''
  }
  const chunkBytes = Buffer.byteLength(chunk, 'utf8')
  if (chunkBytes >= maxBytes) {
    return utf8Tail(chunk, maxBytes)
  }
  return utf8Tail(current, maxBytes - chunkBytes) + chunk
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) {
    return value
  }
  let start = bytes.byteLength - maxBytes
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) {
    start += 1
  }
  return bytes.subarray(start).toString('utf8')
}
