import type { ProcessRunResult } from './ephemeral-vm-recipe-process'

export const EPHEMERAL_VM_CLEANUP_STOPPED_ERROR = 'Cleanup stopped by user.'
export const EPHEMERAL_VM_CLEANUP_TERMINATION_UNCONFIRMED_ERROR =
  'Cleanup stopped, but Orca could not confirm that the provider process tree stopped. Retry cleanup or copy the destroy command.'

type FailedEphemeralVmRecipeDestroy = {
  ok: false
  skipped: false
  error: string
} & ProcessRunResult

export function getEphemeralVmRecipeDestroyFailure(
  result: ProcessRunResult
): FailedEphemeralVmRecipeDestroy | null {
  if (result.aborted) {
    return {
      ok: false,
      skipped: false,
      error: result.terminationFailed
        ? EPHEMERAL_VM_CLEANUP_TERMINATION_UNCONFIRMED_ERROR
        : EPHEMERAL_VM_CLEANUP_STOPPED_ERROR,
      ...result
    }
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      skipped: false,
      error: `Destroy exited with code ${result.exitCode ?? 'unknown'}.`,
      ...result
    }
  }
  return null
}
