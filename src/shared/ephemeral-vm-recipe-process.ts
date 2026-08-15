import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { EphemeralVmRecipeContext } from './ephemeral-vm-recipe-runner'
import {
  hasRecipeProcessExited,
  isRecipeProcessTreeAlive,
  releaseRecipeProcessHandles,
  terminateRecipeProcess
} from './ephemeral-vm-recipe-process-termination'

const DEFAULT_MAX_CAPTURE_BYTES = 1024 * 1024
const CANCEL_FORCE_KILL_DELAY_MS = 5_000
const PROCESS_TREE_EXIT_CHECK_INTERVAL_MS = 50

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
    let gracefulTerminationConfirmed = false
    let gracefulTerminationSettled = false
    let gracefulTreeKillerController: AbortController | undefined
    let stoppedResult: ProcessRunResult | undefined
    let processExited = false
    let processClosed = false
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    let treeExitCheckTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: ProcessRunResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      if (treeExitCheckTimer) {
        clearTimeout(treeExitCheckTimer)
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
      if (treeExitCheckTimer) {
        clearTimeout(treeExitCheckTimer)
      }
      args.signal?.removeEventListener('abort', abort)
      args.forceAbortSignal?.removeEventListener('abort', forceAbort)
      reject(error)
    }
    const finishUnconfirmedExitedProcess = (): void => {
      const result = stoppedResult ?? {
        stdout,
        stderr,
        exitCode: child.exitCode,
        signal: child.signalCode
      }
      finish({ ...result, aborted: true, terminationFailed: true })
      releaseRecipeProcessHandles(child)
    }
    const forceAbort = (): void => {
      if (settled || forceAborting) {
        return
      }
      aborted = true
      if (hasRecipeProcessExited(child, processExited)) {
        finishUnconfirmedExitedProcess()
        return
      }
      forceAborting = true
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      if (treeExitCheckTimer) {
        clearTimeout(treeExitCheckTimer)
      }
      gracefulTreeKillerController?.abort()
      void terminateRecipeProcess(child, true, args.spawnTreeKiller).then((confirmed) => {
        finish({
          stdout,
          stderr,
          exitCode: null,
          signal: null,
          aborted: true,
          ...(!confirmed ? { terminationFailed: true as const } : {})
        })
        releaseRecipeProcessHandles(child)
      })
    }
    const finishStoppedProcessTree = (): void => {
      if (!stoppedResult || !processClosed || settled || forceAborting) {
        return
      }
      if (gracefulTerminationConfirmed || !isRecipeProcessTreeAlive(child)) {
        finish(stoppedResult)
        return
      }
      if (process.platform === 'win32') {
        if (gracefulTerminationSettled) {
          finishUnconfirmedExitedProcess()
        }
        return
      }
      if (treeExitCheckTimer) {
        return
      }
      treeExitCheckTimer = setTimeout(() => {
        treeExitCheckTimer = undefined
        finishStoppedProcessTree()
      }, PROCESS_TREE_EXIT_CHECK_INTERVAL_MS)
      treeExitCheckTimer.unref()
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
      gracefulTreeKillerController = new AbortController()
      void terminateRecipeProcess(
        child,
        false,
        args.spawnTreeKiller,
        gracefulTreeKillerController.signal
      ).then((confirmed) => {
        gracefulTerminationConfirmed = confirmed
        gracefulTerminationSettled = true
        finishStoppedProcessTree()
      })
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
      if (aborted || forceAborting) {
        return
      }
      fail(error)
    })
    child.on('exit', (exitCode, signal) => {
      processExited = true
      stoppedResult = {
        stdout,
        stderr,
        exitCode,
        signal,
        ...(aborted ? { aborted: true as const } : {})
      }
      if (aborted) {
        finishStoppedProcessTree()
      }
    })
    child.on('close', (exitCode, signal) => {
      if (forceAborting) {
        return
      }
      const result = {
        stdout,
        stderr,
        exitCode,
        signal,
        ...(aborted ? { aborted: true as const } : {})
      }
      processClosed = true
      if (!aborted) {
        finish(result)
        return
      }
      stoppedResult = result
      finishStoppedProcessTree()
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
