import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { OrcaRuntimeService } from '../orca-runtime'
import {
  CURRENT_CONTRACT_VERSION,
  LEGACY_CONTRACT_VERSION,
  LEGACY_RUN_ID,
  OrchestrationDb
} from './db'
import { readLegacyWorkerTerminalRecoveryRows } from './orchestration-legacy-worker-recovery-reader'
import { requiresWorkerTerminalReleaseReadiness } from './orchestration-worker-terminal-release-reader'

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

  function snapshotSchema(dbPath: string): { schema: unknown[]; userVersion: number } {
    const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
    try {
      return {
        schema: db
          .prepare(
            'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name'
          )
          .all(),
        userVersion: db.pragma('user_version', { simple: true }) as number
      }
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

  it('classifies v18 recovery rows without changing the database', () => {
    const dbPath = tempDatabasePath()
    const db = new SyncDatabase(dbPath)
    db.exec(`
      CREATE TABLE dispatch_contexts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        capability_hash TEXT,
        assignee_handle TEXT,
        assignee_pane_key TEXT,
        process_incarnation TEXT
      );
      CREATE TABLE worker_dispatches (
        dispatch_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        worktree_id TEXT,
        agent_terminal_handle TEXT
      );
      INSERT INTO dispatch_contexts VALUES
        ('dispatch_legacy', 'task_legacy', '${LEGACY_RUN_ID}', 'dispatched', NULL,
         'term_legacy', 'tab:legacy', 'pty:legacy'),
        ('dispatch_current', 'task_current', '${LEGACY_RUN_ID}', 'dispatched', 'capability',
         'term_current', 'tab:current', 'pty:current');
      INSERT INTO worker_dispatches VALUES
        ('dispatch_legacy', 'ready', 'repo::legacy', 'term_legacy'),
        ('dispatch_current', 'ready', 'repo::current', 'term_current');
      PRAGMA user_version = 18;
    `)
    db.close()
    const before = snapshotSchema(dbPath)

    expect(readLegacyWorkerTerminalRecoveryRows(dbPath)).toEqual([
      expect.objectContaining({
        dispatch_id: 'dispatch_legacy',
        contract_version: LEGACY_CONTRACT_VERSION
      }),
      expect.objectContaining({
        dispatch_id: 'dispatch_current',
        contract_version: CURRENT_CONTRACT_VERSION
      })
    ])
    expect(snapshotSchema(dbPath)).toEqual(before)
  })

  it('keeps startup recovery outside the full schema readiness gate', async () => {
    const { dbPath, dispatchId } = createRecoveryFixture()
    const orchestrationReady = vi.fn()
    const runtime = new OrcaRuntimeService(null, undefined, {
      getOrchestrationDbPath: () => dbPath
    })
    runtime.setNotifier({
      orchestrationReady,
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })

    expect(runtime.prepareLegacyWorkerTerminalRecovery().candidates).toEqual([
      expect.objectContaining({ dispatchId })
    ])
    expect(countMailboxIndexes(dbPath)).toBe(0)

    expect(runtime.syncWindowGraph(1, { tabs: [], leaves: [] }).agentOrchestrationReady).toBe(false)
    expect(orchestrationReady).not.toHaveBeenCalled()
    expect(countMailboxIndexes(dbPath)).toBe(0)
    await runtime.reconcileLegacyWorkerTerminals()
    expect(countMailboxIndexes(dbPath)).toBe(0)

    const db = runtime.getOrchestrationDb()
    try {
      expect(orchestrationReady).toHaveBeenCalledTimes(1)
      runtime.getOrchestrationDb()
      expect(orchestrationReady).toHaveBeenCalledTimes(1)
      expect(countMailboxIndexes(dbPath)).toBe(MAILBOX_INDEXES.length)
      expect(runtime.syncWindowGraph(1, { tabs: [], leaves: [] }).agentOrchestrationReady).toBe(
        true
      )
    } finally {
      db.close()
    }
  })

  it('opens full readiness only when release recovery has durable backlog', async () => {
    const dbPath = tempDatabasePath()
    const fixture = new OrchestrationDb(dbPath)
    fixture.close()
    const raw = new SyncDatabase(dbPath)
    for (const name of MAILBOX_INDEXES) {
      raw.exec(`DROP INDEX IF EXISTS ${name}`)
    }
    raw.exec(`
      INSERT INTO worker_terminal_resources (
        id, origin_dispatch_id, owner_dispatch_id, terminal_handle,
        ownership_state, release_state
      ) VALUES ('wtr_backlog', 'dispatch_backlog', 'dispatch_backlog', 'term_backlog',
                'owned', 'requested')
    `)
    raw.close()

    expect(requiresWorkerTerminalReleaseReadiness(dbPath)).toBe(true)
    const runtime = new OrcaRuntimeService(null, undefined, {
      getOrchestrationDbPath: () => dbPath
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runtime.reconcileLegacyWorkerTerminals()

    expect(countMailboxIndexes(dbPath)).toBe(MAILBOX_INDEXES.length)
    runtime.getOrchestrationDb().close()
    warn.mockRestore()
  })

  it('treats schemas without release resources as no release readiness work', () => {
    const dbPath = tempDatabasePath()
    const db = new SyncDatabase(dbPath)
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY)')
    db.close()

    expect(requiresWorkerTerminalReleaseReadiness(dbPath)).toBe(false)
  })

  it('opens readiness to repair a missing release index', async () => {
    const dbPath = tempDatabasePath()
    const fixture = new OrchestrationDb(dbPath)
    fixture.close()
    const raw = new SyncDatabase(dbPath)
    raw.exec('DROP INDEX idx_worker_terminal_resources_release')
    raw.exec(`
      INSERT INTO worker_terminal_resources (
        id, origin_dispatch_id, owner_dispatch_id, terminal_handle,
        ownership_state, release_state
      ) VALUES ('wtr_missing_index', 'dispatch_missing_index', 'dispatch_missing_index',
                'term_missing_index', 'owned', 'requested')
    `)
    for (const name of MAILBOX_INDEXES) {
      raw.exec(`DROP INDEX IF EXISTS ${name}`)
    }
    raw.close()

    expect(requiresWorkerTerminalReleaseReadiness(dbPath)).toBe(true)
    const runtime = new OrcaRuntimeService(null, undefined, {
      getOrchestrationDbPath: () => dbPath
    })
    await runtime.reconcileLegacyWorkerTerminals()

    expect(countMailboxIndexes(dbPath)).toBe(MAILBOX_INDEXES.length)
    const ready = runtime.getOrchestrationDb()
    try {
      const inspection = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
      try {
        expect(
          inspection
            .prepare(
              "SELECT 1 AS found FROM sqlite_master WHERE type = 'index' AND name = 'idx_worker_terminal_resources_release'"
            )
            .get()
        ).toEqual({ found: 1 })
      } finally {
        inspection.close()
      }
    } finally {
      ready.close()
    }
  })
})
