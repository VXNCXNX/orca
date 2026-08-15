import type { CleanupEphemeralVmRuntimeResult } from './ephemeral-vm-runtime-service'

type CleanupInFlight = {
  controller: AbortController
  promise: Promise<CleanupEphemeralVmRuntimeResult>
}

export const EPHEMERAL_VM_RUNTIME_CLEANUP_DEADLINE_MS = 5 * 60 * 1000

type CleanupDeadlineReason = {
  kind: 'ephemeral-vm-runtime-cleanup-deadline'
  name: 'TimeoutError'
  deadlineMs: number
}

const cleanupInFlight = new Map<string, CleanupInFlight>()

export function runControlledEphemeralVmRuntimeCleanup(args: {
  userDataPath: string
  runtimeId: string
  signal?: AbortSignal
  deadlineMs?: number
  run: (signal: AbortSignal) => Promise<CleanupEphemeralVmRuntimeResult>
}): Promise<CleanupEphemeralVmRuntimeResult> {
  const key = cleanupKey(args)
  const existing = cleanupInFlight.get(key)
  if (existing) {
    return existing.promise
  }

  const controller = new AbortController()
  const deadlineMs = args.deadlineMs ?? EPHEMERAL_VM_RUNTIME_CLEANUP_DEADLINE_MS
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error('VM cleanup deadline must be a positive finite number.')
  }
  const forwardAbort = (): void => controller.abort()
  if (args.signal?.aborted) {
    forwardAbort()
  } else {
    args.signal?.addEventListener('abort', forwardAbort, { once: true })
  }
  const promise = args.run(controller.signal)
  const inFlight = { controller, promise }
  cleanupInFlight.set(key, inFlight)
  const deadlineTimer = controller.signal.aborted
    ? undefined
    : setTimeout(() => {
        controller.abort({
          kind: 'ephemeral-vm-runtime-cleanup-deadline',
          name: 'TimeoutError',
          deadlineMs
        } satisfies CleanupDeadlineReason)
      }, deadlineMs)
  deadlineTimer?.unref()
  const forget = (): void => {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer)
    }
    args.signal?.removeEventListener('abort', forwardAbort)
    if (cleanupInFlight.get(key) === inFlight) {
      cleanupInFlight.delete(key)
    }
  }
  void promise.then(forget, forget)
  return promise
}

export function getEphemeralVmRuntimeCleanupDeadlineMs(signal: AbortSignal): number | null {
  const reason: unknown = signal.reason
  if (
    typeof reason !== 'object' ||
    reason === null ||
    !('kind' in reason) ||
    reason.kind !== 'ephemeral-vm-runtime-cleanup-deadline' ||
    !('deadlineMs' in reason) ||
    typeof reason.deadlineMs !== 'number'
  ) {
    return null
  }
  return reason.deadlineMs
}

export function stopEphemeralVmRuntimeCleanup(args: {
  userDataPath: string
  runtimeId: string
}): Promise<CleanupEphemeralVmRuntimeResult> | null {
  const cleanup = cleanupInFlight.get(cleanupKey(args))
  if (!cleanup) {
    return null
  }
  cleanup.controller.abort()
  return cleanup.promise
}

function cleanupKey(args: { userDataPath: string; runtimeId: string }): string {
  return `${args.userDataPath}\0${args.runtimeId}`
}
