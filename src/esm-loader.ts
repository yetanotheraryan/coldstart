import { Module } from 'node:module'
import { performance } from 'node:perf_hooks'

let port: MessagePortLike | null = null

export async function initialize(data: { port?: MessagePortLike }): Promise<void> {
  port = data.port ?? null
}

export async function resolve(
  specifier: string,
  context: { parentURL?: string },
  nextResolve: (
    specifier: string,
    context: { parentURL?: string }
  ) => Promise<{ url: string; format?: string | null }>
): Promise<{ url: string; format?: string | null }> {
  const result = await nextResolve(specifier, context)
  const isBuiltin = result.format === 'builtin' || isBuiltinModule(specifier) || result.url.startsWith('node:')

  port?.postMessage({
    type: 'resolve',
    request: specifier,
    resolvedPath: isBuiltin ? `builtin:${stripNodePrefix(specifier)}` : result.url,
    parentPath: context.parentURL ?? '<entry>',
    startTime: performance.now(),
    isBuiltin,
    isNodeModule: !isBuiltin && result.url.includes('/node_modules/'),
  })

  return result
}

export async function load(
  url: string,
  context: { format?: string | null },
  nextLoad: (
    url: string,
    context: { format?: string | null }
  ) => Promise<{ format: string; source?: string | ArrayBuffer | Uint8Array }>
): Promise<{ format: string; source?: string | ArrayBuffer | Uint8Array }> {
  const result = await nextLoad(url, context)

  if (result.format !== 'module' || typeof result.source === 'undefined' || shouldSkipInstrumentation(url)) {
    return result
  }

  const sourceText = typeof result.source === 'string'
    ? result.source
    : arrayBufferLikeToString(result.source)

  return {
    ...result,
    source: `${sourceText}\n;globalThis[Symbol.for('coldstart:esm:exit')]?.(${JSON.stringify(url)});\n`,
  }
}

function shouldSkipInstrumentation(url: string): boolean {
  return url.startsWith('node:') || url.startsWith('data:')
}

function stripNodePrefix(value: string): string {
  return value.startsWith('node:') ? value.slice(5) : value
}

function isBuiltinModule(name: string): boolean {
  return Module.isBuiltin?.(name) ?? fallbackBuiltinSet.has(stripNodePrefix(name))
}

function arrayBufferLikeToString(source: ArrayBuffer | Uint8Array): string {
  if (source instanceof Uint8Array) {
    return Buffer.from(source).toString('utf8')
  }

  return Buffer.from(new Uint8Array(source)).toString('utf8')
}

const fallbackBuiltinSet = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel',
  'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl',
  'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])

interface MessagePortLike {
  postMessage(message: unknown): void
}
