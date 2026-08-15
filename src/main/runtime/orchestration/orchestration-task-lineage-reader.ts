import { existsSync } from 'node:fs'
import SyncDatabase from '../../sqlite/sync-database'

const DISPATCH_TASK_INDEX = 'idx_dispatch_task'

function hasColumns(db: SyncDatabase, table: string, required: readonly string[]): boolean {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name?: string }[])
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string')
  )
  return required.every((column) => columns.has(column))
}

function hasDispatchTaskIndex(db: SyncDatabase): boolean {
  const index = (
    db.prepare('PRAGMA index_list(dispatch_contexts)').all() as {
      name?: string
      partial?: number
    }[]
  ).find((row) => row.name === DISPATCH_TASK_INDEX)
  if (!index || index.partial !== 0) {
    return false
  }
  return (
    db.prepare(`PRAGMA index_info(${DISPATCH_TASK_INDEX})`).all() as {
      seqno?: number
      name?: string
    }[]
  ).some((row) => row.seqno === 0 && row.name === 'task_id')
}

function hasDispatchTable(db: SyncDatabase): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('dispatch_contexts')
  )
}

export function readOrchestrationTaskLineageHandles(
  dbPath: string,
  taskIds: readonly string[]
): Map<string, string> {
  const handles = new Map<string, string>()
  if (taskIds.length === 0 || !existsSync(dbPath)) {
    return handles
  }

  const db = new SyncDatabase(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5_000
  })
  try {
    db.pragma('query_only = ON')
    const dispatchTableExists = hasDispatchTable(db)
    const dispatchReadable =
      hasColumns(db, 'dispatch_contexts', ['task_id', 'assignee_handle']) &&
      hasDispatchTaskIndex(db)
    if (dispatchTableExists && !dispatchReadable) {
      return handles
    }
    const taskReadable = hasColumns(db, 'tasks', ['id', 'created_by_terminal_handle'])
    const dispatchStatement = dispatchReadable
      ? db.prepare(
          `SELECT assignee_handle FROM dispatch_contexts INDEXED BY ${DISPATCH_TASK_INDEX}
           WHERE task_id = ? ORDER BY rowid DESC LIMIT 1`
        )
      : null
    const taskStatement = taskReadable
      ? db.prepare('SELECT created_by_terminal_handle FROM tasks WHERE id = ?')
      : null

    for (const taskId of new Set(taskIds)) {
      const dispatch = dispatchStatement?.get(taskId) as
        | { assignee_handle?: string | null }
        | undefined
      const task = taskStatement?.get(taskId) as
        | { created_by_terminal_handle?: string | null }
        | undefined
      const handle = dispatch?.assignee_handle ?? task?.created_by_terminal_handle
      if (typeof handle === 'string' && handle.length > 0) {
        handles.set(taskId, handle)
      }
    }
    return handles
  } finally {
    db.close()
  }
}
