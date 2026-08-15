import { existsSync } from 'node:fs'
import SyncDatabase from '../../sqlite/sync-database'

const RELEASE_INDEX = 'idx_worker_terminal_resources_release'

function hasReleaseIndex(db: SyncDatabase): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(RELEASE_INDEX)
  )
}

export function hasRequestedWorkerTerminalReleaseBacklog(dbPath: string): boolean {
  if (!existsSync(dbPath)) {
    return false
  }
  const db = new SyncDatabase(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5_000
  })
  try {
    db.pragma('query_only = ON')
    if (!hasReleaseIndex(db)) {
      return false
    }
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM worker_terminal_resources INDEXED BY ${RELEASE_INDEX}
           WHERE release_state IN ('requested', 'releasing') LIMIT 1`
        )
        .get()
    )
  } finally {
    db.close()
  }
}
