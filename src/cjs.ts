/**
 * coldstart — cjs.ts
 * Patches Module._load to intercept every require() call and record timing.
 * Must be loaded before any other module via --require coldstart/register
 */

import { Module } from 'module'
import * as path from 'path'
import { tracer } from './tracer'

// Store the original _load so we can call through to it
const originalLoad = (Module as any)._load

// Track the current require() call stack so we can build a parent→child tree.
// Each entry is the resolved filename of the module being loaded right now.
const callStack: string[] = []

;(Module as any)._load = function coldstartLoad(
  request: string,
  parent: NodeModule | null,
  isMain: boolean
): unknown {
  // Resolve the actual file path so we have a stable unique key.
  // _resolveFilename can throw if the module isn't found — let it bubble
  // naturally so we don't swallow real resolution errors.
  let resolvedFilename: string
  try {
    resolvedFilename = (Module as any)._resolveFilename(request, parent, isMain)
  } catch {
    // Module doesn't exist — let the original loader throw the proper error
    return originalLoad.apply(this, arguments)
  }

  // If this module is already cached, Node won't re-execute it.
  // We still want to record it was required (for the dependency graph)
  // but duration will be ~0 since no work happens.
  const isCached = !!(Module as any)._cache[resolvedFilename]
  const isBuiltin = Module.isBuiltin?.(request) ?? isBuiltinModule(request)

  // Determine parent from our own call stack first (more accurate than
  // parent.filename which can be the wrapper module in some cases)
  const parentFilename =
    callStack.length > 0
      ? callStack[callStack.length - 1]
      : parent?.filename ?? '<entry>'

  // Push ourselves onto the stack before calling through — this way any
  // nested require() calls inside this module will see us as their parent
  callStack.push(resolvedFilename)

  const startTime = performance.now()
  let result: unknown

  try {
    result = originalLoad.apply(this, arguments)
  } finally {
    // Always pop — even if the module threw during load
    callStack.pop()

    // Builtins are already recorded in _resolveFilename. Recording them here
    // as well creates duplicate rows like "module / module / module".
    if (!isBuiltin) {
      const duration = performance.now() - startTime

      tracer.record({
        id: resolvedFilename,
        request,                          // original string passed to require()
        resolvedPath: resolvedFilename,
        parentPath: parentFilename,
        durationMs: duration,
        startTime,
        cached: isCached,
        isNodeModule: resolvedFilename.includes('node_modules'),
        isBuiltin: false,
      })
    }
  }

  return result
}

// Also intercept built-in modules (fs, path, http etc.)
// These resolve instantly but knowing they're loaded is useful for the graph.
const originalResolveFilename = (Module as any)._resolveFilename

;(Module as any)._resolveFilename = function coldstartResolve(
  request: string,
  parent: NodeModule | null,
  isMain: boolean,
  options?: object
): string {
  // Builtins return themselves — detect them before calling through
  if (Module.isBuiltin?.(request) ?? isBuiltinModule(request)) {
    const parentFilename =
      callStack.length > 0 ? callStack[callStack.length - 1] : parent?.filename ?? '<entry>'

    // Record builtins with 0 duration — they're loaded by the runtime, not JS
    tracer.record({
      id: `builtin:${request}`,
      request,
      resolvedPath: `builtin:${request}`,
      parentPath: parentFilename,
      durationMs: 0,
      startTime: performance.now(),
      cached: true,
      isNodeModule: false,
      isBuiltin: true,
    })
  }

  return originalResolveFilename.apply(this, arguments)
}

/**
 * Fallback builtin detection for older Node versions that don't have
 * Module.isBuiltin(). Covers all builtins as of Node 22.
 */
function isBuiltinModule(name: string): boolean {
  const builtins = new Set([
    'assert', 'async_hooks', 'buffer', 'child_process', 'cluster',
    'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel',
    'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
    'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
    'process', 'punycode', 'querystring', 'readline', 'repl',
    'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events',
    'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
  ])
  // Handle node: prefix (node:fs, node:path etc.)
  const stripped = name.startsWith('node:') ? name.slice(5) : name
  return builtins.has(stripped)
}
