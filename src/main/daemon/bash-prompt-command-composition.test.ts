import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDaemonBashShellReadyRcfileContent } from './shell-ready'

const hasBash = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0
const itWithBash = hasBash ? it : it.skip

function runInteractiveBash(profile: string, tempHome: string): string {
  const rcfile = join(tempHome, 'rcfile')
  writeFileSync(join(tempHome, '.bash_profile'), profile)
  writeFileSync(rcfile, getDaemonBashShellReadyRcfileContent())
  const result = spawnSync(
    'bash',
    ['-lc', 'bash --noprofile --rcfile "$1" -i 2>&1', 'bash', rcfile],
    {
      input: 'true\nfalse\nexit 0\n',
      encoding: 'utf8',
      env: { ...process.env, HOME: tempHome, ORCA_SHELL_READY_MARKER: '1', TERM: 'xterm' },
      timeout: 5000
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  return result.stdout
}

function expectLifecycle(output: string): void {
  expect(output).not.toContain('syntax error')
  expect(output).toContain('\x1b]133;D;0\x07\x1b]133;A\x07')
  expect(output).toContain('\x1b]133;D;1\x07\x1b]133;A\x07')
  expect(output.split('\x1b]133;C\x07')).toHaveLength(4)
}

describe.skipIf(process.platform === 'win32')('daemon bash PROMPT_COMMAND composition', () => {
  let tempHome: string

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'bash-prompt-command-'))
  })

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true })
  })

  itWithBash.each([
    ['semicolon', ';'],
    ['spaces', ';   '],
    ['tab', ';\t'],
    ['newlines', ';\n\n'],
    ['many separators', '; ;\t\n;;  ']
  ])('composes a value ending in %s', (_name, suffix) => {
    const output = runInteractiveBash(
      `PROMPT_COMMAND='printf "PROMPT_TRAILING\\n"${suffix}'\n`,
      tempHome
    )

    expect(output).toContain('PROMPT_TRAILING')
    expectLifecycle(output)
  })

  itWithBash.each([
    ['space', 'foo\\ ', 'foo '],
    ['semicolon', 'foo\\;', 'foo;']
  ])('preserves an escaped trailing %s', (_name, command, expected) => {
    const profile = `PROMPT_COMMAND='printf "PROMPT_ESCAPED:<%s>\\n" ${command}'\n`
    const output = runInteractiveBash(profile, tempHome)

    expect(output.split(`PROMPT_ESCAPED:<${expected}>`)).toHaveLength(4)
    expectLifecycle(output)
  })
})
