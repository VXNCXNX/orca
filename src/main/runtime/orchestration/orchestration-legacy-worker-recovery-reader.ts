import { existsSync } from 'node:fs'
import SyncDatabase from '../../sqlite/sync-database'
import type { LegacyWorkerTerminalRecoveryRow } from './types'

const REQUIRED_COLUMNS = {
  dispatch_contexts: [
    'id',
    'task_id',
    'status',
    'contract_version',
    'assignee_handle',
    'assignee_pane_key',
    'process_incarnation'
  ],
  worker_dispatches: ['dispatch_id', 'state', 'worktree_id', 'agent_terminal_handle']
} as const

export const LEGACY_WORKER_TERMINAL_RECOVERY_QUERY = `SELECT dc.id AS dispatch_id, dc.task_id, dc.status AS dispatch_status,
       dc.contract_version, dc.assignee_handle, dc.assignee_pane_key,
       dc.process_incarnation, wd.state AS worker_state, wd.worktree_id,
       wd.agent_terminal_handle
FROM dispatch_contexts dc
INNER JOIN worker_dispatches wd ON wd.dispatch_id = dc.id
WHERE wd.state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')
ORDER BY dc.rowid`

function hasRequiredColumns(db: SyncDatabase, table: keyof typeof REQUIRED_COLUMNS): boolean {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name?: string }[])
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string')
  )
  return REQUIRED_COLUMNS[table].every((column) => columns.has(column))
}

export function readLegacyWorkerTerminalRecoveryRows(
  dbPath: string
): LegacyWorkerTerminalRecoveryRow[] {
  if (!existsSync(dbPath)) {
    return []
  }

  const db = new SyncDatabase(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5_000
  })
  try {
    db.pragma('query_only = ON')
    if (
      !hasRequiredColumns(db, 'dispatch_contexts') ||
      !hasRequiredColumns(db, 'worker_dispatches')
    ) {
      return []
    }
    return db
      .prepare(LEGACY_WORKER_TERMINAL_RECOVERY_QUERY)
      .all() as LegacyWorkerTerminalRecoveryRow[]
  } finally {
    db.close()
  }
}
