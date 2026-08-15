import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { OrcaRuntimeService } from '../orca-runtime'
import { CURRENT_CONTRACT_VERSION, OrchestrationDb } from './db'
import { readLegacyWorkerTerminalRecoveryRows } from './orchestration-legacy-worker-recovery-reader'

const MAILBOX_INDEXES = [
  'idx_messages_undelivered_direct_run',
  'idx_messages_unread_current_inbox',
  'idx_messages_unread_current_inbox_type',
  'idx_messages_unread_current_run_type'
] as const

describe('legacy worker recovery reader', () => {
  let tempDir: string | undefined

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function tempDatabasePath(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-legacy-worker-recovery-'))
    return join(tempDir, 'orchestration.db')
  }

  function countMailboxIndexes(dbPath: string): number {
    const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
    try {
      const statement = db.prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'index' AND name = ?"
      )
      return MAILBOX_INDEXES.filter((name) => statement.get(name)).length
    } finally {
      db.close()
    }
  }

  function createRecoveryFixture(): {
    dbPath: string
    dispatchId: string
    taskId: string
  } {
    const dbPath = tempDatabasePath()
    const db = new OrchestrationDb(dbPath)
    const task = db.createTask({ spec: 'recover worker' })
    const started = db.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'pty-worker:22222222-2222-4222-8222-222222222222',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    db.close()

    const raw = new SyncDatabase(dbPath)
    for (const name of MAILBOX_INDEXES) {
      raw.exec(`DROP INDEX IF EXISTS ${name}`)
    }
    raw.pragma('user_version = 28')
    raw.pragma('wal_checkpoint(TRUNCATE)')
    raw.close()
    return { dbPath, dispatchId: started.dispatch.id, taskId: task.id }
  }

  it('reads compatible recovery rows without changing schema readiness', () => {
    const { dbPath, dispatchId, taskId } = createRecoveryFixture()
    const before = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
    const schemaBefore = before
      .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name')
      .all()
    const versionBefore = before.pragma('user_version', { simple: true })
    before.close()

    expect(readLegacyWorkerTerminalRecoveryRows(dbPath)).toEqual([
      {
        dispatch_id: dispatchId,
        task_id: taskId,
        dispatch_status: 'dispatched',
        contract_version: CURRENT_CONTRACT_VERSION,
        assignee_handle: 'term_worker',
        assignee_pane_key: 'tab_worker:11111111-1111-4111-8111-111111111111',
        process_incarnation: 'pty-worker:22222222-2222-4222-8222-222222222222',
        worker_state: 'ready',
        worktree_id: 'repo::worktree',
        agent_terminal_handle: 'term_worker'
      }
    ])

    const after = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
    try {
      expect(
        after
          .prepare(
            'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name'
          )
          .all()
      ).toEqual(schemaBefore)
      expect(after.pragma('user_version', { simple: true })).toBe(versionBefore)
    } finally {
      after.close()
    }
    expect(countMailboxIndexes(dbPath)).toBe(0)
  })

  it('returns no rows for missing or incompatible databases', () => {
    const dbPath = tempDatabasePath()
    expect(readLegacyWorkerTerminalRecoveryRows(dbPath)).toEqual([])

    const db = new SyncDatabase(dbPath)
    db.exec('CREATE TABLE dispatch_contexts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL)')
    db.close()
    expect(readLegacyWorkerTerminalRecoveryRows(dbPath)).toEqual([])
  })

  it('keeps startup recovery outside the full schema readiness gate', () => {
    const { dbPath, dispatchId } = createRecoveryFixture()
    const runtime = new OrcaRuntimeService(null, undefined, {
      getOrchestrationDbPath: () => dbPath
    })

    expect(runtime.prepareLegacyWorkerTerminalRecovery().candidates).toEqual([
      expect.objectContaining({ dispatchId })
    ])
    expect(countMailboxIndexes(dbPath)).toBe(0)

    const db = runtime.getOrchestrationDb()
    try {
      expect(countMailboxIndexes(dbPath)).toBe(MAILBOX_INDEXES.length)
    } finally {
      db.close()
    }
  })
})
