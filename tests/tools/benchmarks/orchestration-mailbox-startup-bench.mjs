#!/usr/bin/env node
/**
 * Measures STA-4408's first-upgrade startup boundary separately from eventual
 * orchestration DB readiness.
 *
 * Usage:
 *   pnpm bench:orchestration-mailbox-startup --expect eager --rows 250000
 */
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const repoRoot = resolve(import.meta.dirname, '..', '..', '..')
const MAILBOX_INDEXES = [
  'idx_messages_undelivered_direct_run',
  'idx_messages_unread_current_inbox',
  'idx_messages_unread_current_inbox_type',
  'idx_messages_unread_current_run_type'
]

function parseArgs(argv) {
  const args = { expect: 'deferred', rows: 250_000, keepFixtures: false }
  for (let index = 2; index < argv.length; index += 1) {
    const next = () => argv[++index]
    switch (argv[index]) {
      case '--':
        break
      case '--expect':
        args.expect = next()
        break
      case '--rows':
        args.rows = Number(next())
        break
      case '--keep-fixtures':
        args.keepFixtures = true
        break
      default:
        throw new Error(`Unknown argument: ${argv[index]}`)
    }
  }
  if (!['deferred', 'eager'].includes(args.expect)) {
    throw new Error('--expect must be deferred or eager')
  }
  if (!Number.isInteger(args.rows) || args.rows < 0) {
    throw new Error('--rows must be a non-negative integer')
  }
  return args
}

function buildDatabaseFixtureFactory(root) {
  const output = join(root, 'orchestration-db.cjs')
  buildSync({
    entryPoints: [join(repoRoot, 'src/main/runtime/orchestration/db.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    logLevel: 'silent'
  })
  return require(output).OrchestrationDb
}

function openRawDatabase(path, options) {
  const { DatabaseSync } = require('node:sqlite')
  return options ? new DatabaseSync(path, options) : new DatabaseSync(path)
}

function countMailboxIndexes(db) {
  const hasIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
  return MAILBOX_INDEXES.filter((name) => hasIndex.get(name)).length
}

function inspectDatabase(path) {
  const db = openRawDatabase(path, { readOnly: true })
  try {
    return {
      indexes: countMailboxIndexes(db),
      rows: Number(db.prepare('SELECT count(*) AS count FROM messages').get().count),
      userVersion: Number(db.prepare('PRAGMA user_version').get().user_version)
    }
  } finally {
    db.close()
  }
}

function createTemplate(path, rows, OrchestrationDb) {
  const orchestrationDb = new OrchestrationDb(path)
  orchestrationDb.close()
  const db = openRawDatabase(path)
  for (const name of MAILBOX_INDEXES) {
    db.exec(`DROP INDEX IF EXISTS ${name}`)
  }
  const insert = db.prepare(`
    INSERT INTO messages (
      id, run_id, delivery_contract, from_handle, to_handle, subject, body,
      type, priority, read, created_at, delivered_at
    ) VALUES (?, ?, ?, ?, ?, 'fixture', '', ?, 'normal', ?, CURRENT_TIMESTAMP, ?)
  `)
  const types = ['status', 'worker_done', 'heartbeat', 'question']
  db.exec('BEGIN')
  try {
    for (let index = 0; index < rows; index += 1) {
      const bucket = index % 10
      insert.run(
        `msg_${index}`,
        `run_${index % 64}`,
        bucket === 8 ? 'legacy_direct' : bucket === 9 ? 'audit_only' : 'current_delivery',
        `term_${index % 128}`,
        `term_${index % 256}`,
        types[index % types.length],
        bucket === 7 || bucket === 9 ? 1 : 0,
        bucket < 6 || bucket === 7 || bucket === 8 ? null : '2026-01-01'
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  db.exec('PRAGMA user_version = 28')
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
}

function measureConstructor(path, OrchestrationDb) {
  const started = performance.now()
  const db = new OrchestrationDb(path)
  const elapsedMs = performance.now() - started
  db.close()
  return Number(elapsedMs.toFixed(1))
}

function parseStartupLine(line) {
  const match = /^\[startup\] (\S+)(.*)$/.exec(line)
  if (!match) {
    return null
  }
  const time = /(?:^|\s)t=(\d+(?:\.\d+)?)(?:\s|$)/.exec(match[2])
  return { event: match[1], time: time ? Number(time[1]) : null }
}

function killProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  child.kill('SIGKILL')
}

function launchElectron(profilePath) {
  return new Promise((resolvePromise, reject) => {
    const homePath = join(profilePath, 'home')
    mkdirSync(homePath, { recursive: true })
    const child = spawn(require('electron'), [repoRoot], {
      env: {
        ...process.env,
        HOME: homePath,
        USERPROFILE: homePath,
        ORCA_E2E_HEADLESS: '1',
        ORCA_E2E_HOME_DIR: homePath,
        ORCA_E2E_USER_DATA_DIR: profilePath,
        ORCA_STARTUP_DIAGNOSTICS: '1'
      },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    const events = []
    let buffer = ''
    let settled = false
    const finish = (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      setTimeout(() => {
        killProcessTree(child)
        if (error) {
          reject(error)
        } else {
          resolvePromise(events)
        }
      }, 100)
    }
    const timeout = setTimeout(() => finish(new Error('Electron startup timed out')), 30_000)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const parsed = parseStartupLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!parsed) {
          continue
        }
        events.push(parsed)
        if (parsed.event === 'did-finish-load') {
          finish()
        }
      }
    })
    child.once('error', finish)
    child.once('exit', (code) => {
      if (!settled) {
        finish(new Error(`Electron exited before first load (${code ?? 'signal'})`))
      }
    })
  })
}

function eventTime(events, event) {
  return events.find((entry) => entry.event === event)?.time ?? null
}

async function main() {
  const args = parseArgs(process.argv)
  if (!existsSync(join(repoRoot, 'out', 'main', 'index.js'))) {
    throw new Error('out/main/index.js missing; run pnpm build:electron-vite first')
  }
  const root = mkdtempSync(join(tmpdir(), 'orca-mailbox-startup-bench-'))
  try {
    const OrchestrationDb = buildDatabaseFixtureFactory(root)
    const templatePath = join(root, 'template.db')
    createTemplate(templatePath, args.rows, OrchestrationDb)
    const directPath = join(root, 'direct.db')
    copyFileSync(templatePath, directPath)
    const totalEventualMigrationMs = measureConstructor(directPath, OrchestrationDb)

    const profilePath = join(root, 'profile')
    mkdirSync(profilePath)
    copyFileSync(templatePath, join(profilePath, 'orchestration.db'))
    writeFileSync(
      join(profilePath, 'orca-data.json'),
      JSON.stringify({ schemaVersion: 1, repos: [], settings: {} })
    )
    const events = await launchElectron(profilePath)
    const afterStartup = inspectDatabase(join(profilePath, 'orchestration.db'))
    const appReady = eventTime(events, 'app-ready')
    const openWindow = eventTime(events, 'open-main-window-start')
    const startupBlockingMs =
      appReady === null || openWindow === null ? null : Number((openWindow - appReady).toFixed(1))
    const eventualAfterStartupMs = measureConstructor(
      join(profilePath, 'orchestration.db'),
      OrchestrationDb
    )
    const afterEventual = inspectDatabase(join(profilePath, 'orchestration.db'))
    const result = {
      expected: args.expect,
      fixture: { rows: args.rows, distribution: '60% current unread undelivered' },
      startup: { blockingMs: startupBlockingMs, database: afterStartup },
      eventual: {
        cleanTemplateMs: totalEventualMigrationMs,
        afterStartupMs: eventualAfterStartupMs,
        database: afterEventual
      }
    }
    const expectedStartupIndexes = args.expect === 'eager' ? MAILBOX_INDEXES.length : 0
    if (afterStartup.indexes !== expectedStartupIndexes) {
      throw new Error(
        `Expected ${expectedStartupIndexes} mailbox indexes after startup, found ${afterStartup.indexes}`
      )
    }
    if (afterEventual.indexes !== MAILBOX_INDEXES.length) {
      throw new Error('Eventual OrchestrationDb construction did not reach index readiness')
    }
    console.log(JSON.stringify(result, null, 2))
    if (args.keepFixtures) {
      const kept = join(repoRoot, 'tests', 'tools', 'benchmarks', 'results', 'sta4408-fixture')
      rmSync(kept, { recursive: true, force: true })
      cpSync(root, kept, { recursive: true })
      console.log(`Fixtures kept at ${kept}`)
    }
  } finally {
    if (!args.keepFixtures) {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
