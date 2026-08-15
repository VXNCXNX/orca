import { existsSync } from 'node:fs'
import SyncDatabase from '../../sqlite/sync-database'

const RELEASE_INDEX = 'idx_worker_terminal_resources_release'

function hasReleaseIndex(db: SyncDatabase): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(RELEASE_INDEX)
  )
}

function hasReleaseStateColumn(db: SyncDatabase): boolean {
  return (
    db.prepare('PRAGMA table_info(worker_terminal_resources)').all() as { name?: string }[]
  ).some((row) => row.name === 'release_state')
}

export function requiresWorkerTerminalReleaseReadiness(dbPath: string): boolean {
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
    if (!hasReleaseStateColumn(db)) {
      return false
    }
    if (!hasReleaseIndex(db)) {
      return true
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
