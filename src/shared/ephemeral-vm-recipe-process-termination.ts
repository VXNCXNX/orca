import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export const RECIPE_PROCESS_TREE_TERMINATION_TIMEOUT_MS = 5_000
const POSIX_PROCESS_TREE_EXIT_CHECK_INTERVAL_MS = 50

export function terminateRecipeProcess(
  child: ChildProcessWithoutNullStreams,
  force: boolean,
  spawnTreeKiller = spawn,
  treeKillerCancelSignal?: AbortSignal
): Promise<boolean> {
  const signal = force ? 'SIGKILL' : 'SIGTERM'
  if (process.platform === 'win32') {
    if (child.pid) {
      return terminateWindowsRecipeProcess(
        child,
        signal,
        force,
        spawnTreeKiller,
        treeKillerCancelSignal
      )
    }
    child.kill(signal)
    return Promise.resolve(false)
  }
  if (child.pid) {
    try {
      // Recipes run through a shell; the process group owns its descendants.
      process.kill(-child.pid, signal)
      return force
        ? waitForPosixProcessGroupExit(child.pid)
        : Promise.resolve(!isPosixProcessGroupAlive(child.pid))
    } catch (error) {
      return Promise.resolve(isProcessNotFoundError(error))
    }
  }
  child.kill(signal)
  return Promise.resolve(false)
}

function waitForPosixProcessGroupExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + RECIPE_PROCESS_TREE_TERMINATION_TIMEOUT_MS
  return new Promise((resolve) => {
    const check = (): void => {
      if (!isPosixProcessGroupAlive(pid)) {
        resolve(true)
        return
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        resolve(false)
        return
      }
      const timer = setTimeout(
        check,
        Math.min(POSIX_PROCESS_TREE_EXIT_CHECK_INTERVAL_MS, remainingMs)
      )
      timer.unref()
    }
    check()
  })
}

export function isRecipeProcessTreeAlive(child: ChildProcessWithoutNullStreams): boolean {
  if (!child.pid) {
    return false
  }
  if (process.platform === 'win32') {
    return true
  }
  return isPosixProcessGroupAlive(child.pid)
}

export function releaseRecipeProcessHandles(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
  child.unref()
}

export function hasRecipeProcessExited(
  child: ChildProcessWithoutNullStreams,
  observedExit: boolean
): boolean {
  return (
    observedExit ||
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  )
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return !isProcessNotFoundError(error)
  }
}

function isProcessNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
}

function terminateWindowsRecipeProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
  force: boolean,
  spawnTreeKiller: typeof spawn,
  treeKillerCancelSignal: AbortSignal | undefined
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let killer: ReturnType<typeof spawn>
    let timeout: ReturnType<typeof setTimeout>
    const onError = (): void => finish(false)
    const onClose = (exitCode: number | null): void => finish(exitCode === 0)
    const onCancel = (): void => {
      stopTreeKiller()
      finish(false, false)
    }
    const stopTreeKiller = (): void => {
      killer.removeListener('error', onError)
      killer.once('error', ignoreLateTreeKillerError)
      killer.kill('SIGKILL')
      killer.unref()
    }
    const finish = (confirmed: boolean, killChild = force): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      killer.removeListener('error', onError)
      killer.removeListener('close', onClose)
      treeKillerCancelSignal?.removeEventListener('abort', onCancel)
      if (!confirmed && killChild) {
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
      if (force) {
        child.kill(signal)
      }
      resolve(false)
      return
    }
    timeout = setTimeout(() => {
      stopTreeKiller()
      finish(false)
    }, RECIPE_PROCESS_TREE_TERMINATION_TIMEOUT_MS)
    timeout.unref()
    killer.once('error', onError)
    killer.once('close', onClose)
    treeKillerCancelSignal?.addEventListener('abort', onCancel, { once: true })
  })
}

function ignoreLateTreeKillerError(): void {
  // The timeout already records this tree kill as unconfirmed.
}
