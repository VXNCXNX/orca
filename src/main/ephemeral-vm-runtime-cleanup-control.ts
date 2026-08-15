import type { CleanupEphemeralVmRuntimeResult } from './ephemeral-vm-runtime-service'
import { armEphemeralVmDestroyDeadline } from './ephemeral-vm-destroy-deadline'

type CleanupInFlight = {
  stopController: AbortController
  promise: Promise<CleanupEphemeralVmRuntimeResult>
}

const cleanupInFlight = new Map<string, CleanupInFlight>()

export function runControlledEphemeralVmRuntimeCleanup(args: {
  userDataPath: string
  runtimeId: string
  signal?: AbortSignal
  run: (signals: {
    signal: AbortSignal
    deadlineSignal: AbortSignal
  }) => Promise<CleanupEphemeralVmRuntimeResult>
}): Promise<CleanupEphemeralVmRuntimeResult> {
  const key = cleanupKey(args)
  const existing = cleanupInFlight.get(key)
  if (existing) {
    return existing.promise
  }

  const stopController = new AbortController()
  const deadlineController = new AbortController()
  const disarmDeadline = armEphemeralVmDestroyDeadline(deadlineController)
  const forwardAbort = (): void => stopController.abort()
  if (args.signal?.aborted) {
    forwardAbort()
  } else {
    args.signal?.addEventListener('abort', forwardAbort, { once: true })
  }
  let promise: Promise<CleanupEphemeralVmRuntimeResult>
  try {
    promise = args.run({
      signal: stopController.signal,
      deadlineSignal: deadlineController.signal
    })
  } catch (error) {
    disarmDeadline()
    args.signal?.removeEventListener('abort', forwardAbort)
    throw error
  }
  const inFlight = { stopController, promise }
  cleanupInFlight.set(key, inFlight)
  const forget = (): void => {
    disarmDeadline()
    args.signal?.removeEventListener('abort', forwardAbort)
    if (cleanupInFlight.get(key) === inFlight) {
      cleanupInFlight.delete(key)
    }
  }
  void promise.then(forget, forget)
  return promise
}

export function stopEphemeralVmRuntimeCleanup(args: {
  userDataPath: string
  runtimeId: string
}): Promise<CleanupEphemeralVmRuntimeResult> | null {
  const cleanup = cleanupInFlight.get(cleanupKey(args))
  if (!cleanup) {
    return null
  }
  cleanup.stopController.abort()
  return cleanup.promise
}

function cleanupKey(args: { userDataPath: string; runtimeId: string }): string {
  return `${args.userDataPath}\0${args.runtimeId}`
}
