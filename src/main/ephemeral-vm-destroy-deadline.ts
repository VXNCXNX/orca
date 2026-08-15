import { RECIPE_PROCESS_TREE_TERMINATION_TIMEOUT_MS } from '../shared/ephemeral-vm-recipe-process'

export const EPHEMERAL_VM_DESTROY_DEADLINE_MS = 5 * 60 * 1000

type DestroyDeadlineReason = {
  kind: 'ephemeral-vm-destroy-deadline'
  name: 'TimeoutError'
  deadlineMs: number
}

export function armEphemeralVmDestroyDeadline(controller: AbortController): () => void {
  const processDeadlineMs =
    EPHEMERAL_VM_DESTROY_DEADLINE_MS - RECIPE_PROCESS_TREE_TERMINATION_TIMEOUT_MS
  const timer = setTimeout(() => {
    controller.abort({
      kind: 'ephemeral-vm-destroy-deadline',
      name: 'TimeoutError',
      deadlineMs: EPHEMERAL_VM_DESTROY_DEADLINE_MS
    } satisfies DestroyDeadlineReason)
  }, processDeadlineMs)
  timer.unref()
  return () => clearTimeout(timer)
}

export function getEphemeralVmDestroyDeadlineMs(signal: AbortSignal): number | null {
  const reason: unknown = signal.reason
  if (
    typeof reason !== 'object' ||
    reason === null ||
    !('kind' in reason) ||
    reason.kind !== 'ephemeral-vm-destroy-deadline' ||
    !('deadlineMs' in reason) ||
    typeof reason.deadlineMs !== 'number'
  ) {
    return null
  }
  return reason.deadlineMs
}

export function getEphemeralVmDestroyDeadlineError(
  deadlineMs: number,
  terminationFailed = false
): string {
  const duration = deadlineMs % 60_000 === 0 ? `${deadlineMs / 60_000}-minute` : `${deadlineMs}ms`
  const recovery = 'Retry cleanup or copy the destroy command.'
  const termination = terminationFailed
    ? ' Orca could not confirm that the provider process tree stopped.'
    : ''
  return `Cleanup did not complete within its ${duration} deadline.${termination} ${recovery}`
}
