import { mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { pathToFileURL } from 'url'
import { MessageChannel } from 'worker_threads'
import { register as registerHooks } from 'node:module'
import './src/cjs'
import type { ModuleLoadEvent } from './src/tracer'
import { tracer } from './src/tracer'

const ESM_EXIT_SYMBOL = Symbol.for('coldstart:esm:exit')
const COLDSTART_REGISTERED = Symbol.for('coldstart:registered')
const COLDSTART_ESM_PORT = Symbol.for('coldstart:esm:port')
const reportFile = process.env.COLDSTART_REPORT_FILE

if (!(globalThis as Record<PropertyKey, unknown>)[COLDSTART_REGISTERED]) {
  ;(globalThis as Record<PropertyKey, unknown>)[COLDSTART_REGISTERED] = true
  setupEsmHooks()
}

if (reportFile) {
  let flushed = false
  let beforeExitScheduled = false

  const flushReport = (): void => {
    if (flushed) {
      return
    }

    flushed = true

    try {
      mkdirSync(dirname(reportFile), { recursive: true })
      writeFileSync(reportFile, JSON.stringify(tracer.report(), jsonReplacer), 'utf8')
    } catch {
      // Ignore write failures so instrumentation does not break app startup.
    }

    closeEsmPort()
  }

  process.once('beforeExit', () => {
    if (beforeExitScheduled) {
      return
    }

    beforeExitScheduled = true
    setImmediate(flushReport)
  })
  process.once('exit', flushReport)
  process.once('SIGINT', () => {
    flushReport()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    flushReport()
    process.exit(143)
  })
  process.once('uncaughtException', error => {
    flushReport()
    throw error
  })
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return 0
  }

  return value
}

function setupEsmHooks(): void {
  if (typeof registerHooks !== 'function') {
    return
  }

  const { port1, port2 } = new MessageChannel()
  const pendingByUrl = new Map<string, ModuleLoadEvent[]>()
  const completedAtByUrl = new Map<string, number>()
  const finalizedUrls = new Set<string>()
  let closeTimer: NodeJS.Timeout | null = null

  ;(globalThis as Record<PropertyKey, unknown>)[COLDSTART_ESM_PORT] = port1
  port1.unref()

  const schedulePortClose = (): void => {
    if (closeTimer) {
      clearTimeout(closeTimer)
    }

    closeTimer = setTimeout(() => {
      closeTimer = null
      closeEsmPort()
    }, 25)
  }

  if (!reportFile) {
    process.once('beforeExit', () => {
      setImmediate(closeEsmPort)
    })
  }

  process.once('exit', closeEsmPort)

  port1.on('message', rawMessage => {
    schedulePortClose()

    if (!isEsmResolveMessage(rawMessage)) {
      return
    }

    const event: ModuleLoadEvent = {
      id: rawMessage.isBuiltin ? `builtin:${rawMessage.request}` : rawMessage.resolvedPath,
      request: rawMessage.request,
      resolvedPath: rawMessage.resolvedPath,
      parentPath: rawMessage.parentPath,
      durationMs: 0,
      startTime: rawMessage.startTime,
      cached: rawMessage.isBuiltin,
      isNodeModule: rawMessage.isNodeModule,
      isBuiltin: rawMessage.isBuiltin,
    }

    if (event.isBuiltin) {
      tracer.record(event)
      return
    }

    const completedAt = completedAtByUrl.get(event.resolvedPath)
    if (typeof completedAt === 'number' && !finalizedUrls.has(event.resolvedPath)) {
      tracer.record({
        ...event,
        durationMs: Math.max(0, completedAt - event.startTime),
        cached: false,
      })
      finalizedUrls.add(event.resolvedPath)
      completedAtByUrl.delete(event.resolvedPath)
      return
    }

    if (finalizedUrls.has(event.resolvedPath)) {
      tracer.record({
        ...event,
        startTime: performance.now(),
        durationMs: 0,
        cached: true,
      })
      return
    }

    const existing = pendingByUrl.get(event.resolvedPath) ?? []
    existing.push(event)
    pendingByUrl.set(event.resolvedPath, existing)
  })

  ;(globalThis as Record<PropertyKey, unknown>)[ESM_EXIT_SYMBOL] = (resolvedPath: string): void => {
    const endTime = performance.now()
    const pending = pendingByUrl.get(resolvedPath)

    schedulePortClose()

    if (!pending || pending.length === 0) {
      completedAtByUrl.set(resolvedPath, endTime)
      return
    }

    const [primary, ...rest] = pending

    tracer.record({
      ...primary,
      durationMs: Math.max(0, endTime - primary.startTime),
      cached: false,
    })

    for (const cachedEdge of rest) {
      tracer.record({
        ...cachedEdge,
        startTime: endTime,
        durationMs: 0,
        cached: true,
      })
    }

    pendingByUrl.delete(resolvedPath)
    completedAtByUrl.delete(resolvedPath)
    finalizedUrls.add(resolvedPath)
  }

  try {
    registerHooks('./esm-loader.mjs', {
      parentURL: pathToFileURL(__filename),
      data: { port: port2 },
      transferList: [port2],
    })
    schedulePortClose()
  } catch {
    // Older Node versions or unsupported runtimes should still keep CJS profiling working.
  }
}

function closeEsmPort(): void {
  const port = (globalThis as Record<PropertyKey, unknown>)[COLDSTART_ESM_PORT] as
    | { close?: () => void }
    | undefined

  try {
    port?.close?.()
  } catch {
    // Ignore teardown errors during process shutdown.
  }

  delete (globalThis as Record<PropertyKey, unknown>)[COLDSTART_ESM_PORT]
}

function isEsmResolveMessage(value: unknown): value is {
  type: 'resolve'
  request: string
  resolvedPath: string
  parentPath: string
  startTime: number
  isBuiltin: boolean
  isNodeModule: boolean
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'resolve'
  )
}
