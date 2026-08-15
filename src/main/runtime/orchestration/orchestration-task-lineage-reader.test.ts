import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { readOrchestrationTaskLineageHandles } from './orchestration-task-lineage-reader'

describe('orchestration task lineage reader', () => {
  let tempDir: string | undefined

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function databasePath(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-task-lineage-reader-'))
    return join(tempDir, 'orchestration.db')
  }

  it('reads latest dispatch handles with task-creator fallback without writing', () => {
    const dbPath = databasePath()
    const db = new SyncDatabase(dbPath)
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        created_by_terminal_handle TEXT
      );
      CREATE TABLE dispatch_contexts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        assignee_handle TEXT
      );
      CREATE INDEX idx_dispatch_task ON dispatch_contexts(task_id);
      INSERT INTO tasks VALUES
        ('task_dispatched', 'term_creator_old'),
        ('task_creator', 'term_creator'),
        ('task_latest_null', 'term_fallback');
      INSERT INTO dispatch_contexts VALUES
        ('ctx_old', 'task_dispatched', 'term_worker_old'),
        ('ctx_latest', 'task_dispatched', 'term_worker_latest'),
        ('ctx_null', 'task_latest_null', NULL);
      PRAGMA user_version = 18;
    `)
    const before = db
      .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
      .all()
    db.close()

    const handles = readOrchestrationTaskLineageHandles(dbPath, [
      'task_dispatched',
      'task_creator',
      'task_latest_null',
      'task_missing',
      'task_dispatched'
    ])

    expect(Object.fromEntries(handles)).toEqual({
      task_dispatched: 'term_worker_latest',
      task_creator: 'term_creator',
      task_latest_null: 'term_fallback'
    })
    const after = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
    try {
      expect(
        after
          .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
          .all()
      ).toEqual(before)
      expect(after.pragma('user_version', { simple: true })).toBe(18)
    } finally {
      after.close()
    }
  })

  it('defers lineage when an existing dispatch table cannot be queried by index', () => {
    const dbPath = databasePath()
    const db = new SyncDatabase(dbPath)
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        created_by_terminal_handle TEXT
      );
      CREATE TABLE dispatch_contexts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        assignee_handle TEXT
      );
      INSERT INTO tasks VALUES ('task_creator', 'term_creator');
      INSERT INTO dispatch_contexts VALUES ('ctx', 'task_creator', 'term_worker');
    `)
    db.close()

    expect(readOrchestrationTaskLineageHandles(dbPath, ['task_creator'])).toEqual(new Map())
  })

  it('returns no handles for missing databases or empty requests', () => {
    const dbPath = databasePath()
    expect(readOrchestrationTaskLineageHandles(dbPath, ['task_missing'])).toEqual(new Map())

    const db = new SyncDatabase(dbPath)
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY)')
    db.close()
    expect(readOrchestrationTaskLineageHandles(dbPath, [])).toEqual(new Map())
  })
})
