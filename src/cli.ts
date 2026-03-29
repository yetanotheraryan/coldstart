#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { spawn } from 'child_process'
import { renderJsonReport } from './reporter/json'
import { renderTextReport } from './reporter/text'
import type { StartupReport } from './tracer'

interface CliOptions {
  output: 'text' | 'json'
  color: boolean
  help: boolean
  targetArgs: string[]
}

const options = parseArgs(process.argv.slice(2))

if (options.help || options.targetArgs.length === 0) {
  printHelp(options.targetArgs.length === 0 ? 1 : 0)
} else {
  run(options).catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`coldstart: ${message}\n`)
    process.exitCode = 1
  })
}

async function run(options: CliOptions): Promise<void> {
  const tempDir = mkdtempSync(join(tmpdir(), 'coldstart-'))
  const reportPath = join(tempDir, 'startup-report.json')
  const childArgs = buildChildArgs(options.targetArgs)
  const child = spawn(process.execPath, childArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      COLDSTART_REPORT_FILE: reportPath,
    },
  })

  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (!child.killed) {
      child.kill(signal)
    }
  }

  process.once('SIGINT', () => forwardSignal('SIGINT'))
  process.once('SIGTERM', () => forwardSignal('SIGTERM'))

  const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })

  let report: StartupReport | null = null

  if (existsSync(reportPath)) {
    report = JSON.parse(readFileSync(reportPath, 'utf8')) as StartupReport
  }

  rmSync(tempDir, { recursive: true, force: true })

  if (report) {
    const output =
      options.output === 'json'
        ? renderJsonReport(report)
        : `${renderTextReport(report, { color: options.color })}\n`

    process.stdout.write(output)
  } else {
    process.stderr.write('coldstart: no startup report was captured\n')
  }

  if (exitInfo.signal) {
    process.kill(process.pid, exitInfo.signal)
    return
  }

  process.exitCode = exitInfo.code ?? 1
}

function parseArgs(argv: string[]): CliOptions {
  const targetArgs: string[] = []
  let output: 'text' | 'json' = 'text'
  let color = process.stdout.isTTY
  let help = false
  let passthrough = false

  for (const arg of argv) {
    if (passthrough) {
      targetArgs.push(arg)
      continue
    }

    if (arg === '--') {
      passthrough = true
      continue
    }

    if (arg === '--json') {
      output = 'json'
      continue
    }

    if (arg === '--no-color') {
      color = false
      continue
    }

    if (arg === '--color') {
      color = true
      continue
    }

    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }

    targetArgs.push(arg)
  }

  return { output, color, help, targetArgs }
}

function buildChildArgs(targetArgs: string[]): string[] {
  const registerPath = resolve(__dirname, 'register.mjs')

  if (targetArgs[0] === 'node') {
    return ['--import', registerPath, ...targetArgs.slice(1)]
  }

  return ['--import', registerPath, ...targetArgs]
}

function printHelp(exitCode: number): never {
  const helpText = [
    'Usage:',
    '  coldstart [--json] [--no-color] app.js [args...]',
    '  coldstart [--json] [--no-color] -- node [node-flags...] app.js [args...]',
    '',
    'Examples:',
    '  coldstart server.js',
    '  coldstart --json server.js',
    '  coldstart -- node --trace-warnings server.js',
  ].join('\n')

  const stream = exitCode === 0 ? process.stdout : process.stderr
  stream.write(`${helpText}\n`)
  process.exit(exitCode)
}
