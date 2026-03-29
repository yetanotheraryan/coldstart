/**
 * coldstart — tracer.ts
 * Receives raw module load events from cjs.ts and builds:
 *  - A call tree (parent → children)
 *  - Inclusive timing (module + all its transitive requires)
 *  - Exclusive timing (module's own code only, not children)
 *  - Top slowest modules list
 *  - Event loop blocking stats (via perf_hooks)
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ModuleLoadEvent {
  id: string               // unique key — resolvedPath or builtin:name
  request: string          // original string passed to require()
  resolvedPath: string     // absolute path on disk (or builtin:name)
  parentPath: string       // who required this module
  durationMs: number       // wall time for this require() call (inclusive of children)
  startTime: number        // performance.now() at require() start
  cached: boolean          // was it already in Module._cache?
  isNodeModule: boolean    // lives inside node_modules?
  isBuiltin: boolean       // Node.js builtin (fs, path, etc.)?
}

export interface ModuleNode {
  id: string
  request: string
  resolvedPath: string
  parentPath: string
  inclusiveMs: number      // total time including all children
  exclusiveMs: number      // own time only (inclusive - sum of children's inclusive)
  cached: boolean
  isNodeModule: boolean
  isBuiltin: boolean
  children: ModuleNode[]
  depth: number            // depth in the require tree, root = 0
}

export interface StartupReport {
  totalStartupMs: number
  eventLoop: {
    maxBlockMs: number
    meanBlockMs: number
    p99BlockMs: number
  }
  tree: ModuleNode[]                    // root nodes (entry point + its children)
  flat: ModuleNode[]                    // all nodes, sorted by inclusiveMs desc
  slowest: ModuleNode[]                 // top 10 by exclusiveMs (actual offenders)
  nodeModuleTime: number                // total ms spent loading node_modules
  firstPartyTime: number                // total ms spent on your own code
  totalModulesLoaded: number
  cachedModulesCount: number
}

// ─── Tracer ───────────────────────────────────────────────────────────────────

class Tracer {
  private events: ModuleLoadEvent[] = []
  private startTime: number = performance.now()
  private histogram: IntervalHistogram | null = null

  constructor() {
    // Start monitoring event loop delay immediately — we want to capture
    // any blocking that happens during the very first requires
    try {
      this.histogram = monitorEventLoopDelay({ resolution: 5 })
      this.histogram.enable()
    } catch {
      // perf_hooks not available in this environment — degrade gracefully
      this.histogram = null
    }
  }

  /**
   * Called by cjs.ts for every require() interception.
   * Appends to the flat event list — tree is built lazily on report().
   */
  record(event: ModuleLoadEvent): void {
    this.events.push(event)
  }

  /**
   * Mark startup as complete and return the full report.
   * Call this after your server/app signals it's ready.
   */
  report(): StartupReport {
    const totalStartupMs = performance.now() - this.startTime

    // Stop ELD monitoring
    if (this.histogram) {
      this.histogram.disable()
    }

    const tree = this.buildTree()
    const flat = this.flatten(tree).sort((a, b) => b.inclusiveMs - a.inclusiveMs)
    const slowest = [...flat]
      .filter(n => !n.cached && !n.isBuiltin)
      .sort((a, b) => b.exclusiveMs - a.exclusiveMs)
      .slice(0, 10)

    const nodeModuleTime = flat
      .filter(n => n.isNodeModule && !n.cached)
      .reduce((sum, n) => sum + n.exclusiveMs, 0)

    const firstPartyTime = flat
      .filter(n => !n.isNodeModule && !n.isBuiltin && !n.cached)
      .reduce((sum, n) => sum + n.exclusiveMs, 0)

    return {
      totalStartupMs,
      eventLoop: {
        maxBlockMs: this.histogram ? this.histogram.max / 1e6 : 0,
        meanBlockMs: this.histogram ? this.histogram.mean / 1e6 : 0,
        p99BlockMs: this.histogram ? this.histogram.percentile(99) / 1e6 : 0,
      },
      tree,
      flat,
      slowest,
      nodeModuleTime,
      firstPartyTime,
      totalModulesLoaded: this.events.length,
      cachedModulesCount: this.events.filter(e => e.cached).length,
    }
  }

  /**
   * Build the parent→child tree from the flat event list.
   *
   * Strategy:
   * 1. Create a ModuleNode for each event
   * 2. Wire children to parents using parentPath
   * 3. Compute exclusive time = inclusive - sum(children inclusive)
   * 4. Assign depth via BFS from roots
   */
  private buildTree(): ModuleNode[] {
    // Deduplicate — a module can appear multiple times if required from
    // different parents. We keep all occurrences (the graph is a DAG, not
    // a tree) but represent each require() edge separately.
    const nodes: ModuleNode[] = this.events.map(e => ({
      id: e.id,
      request: e.request,
      resolvedPath: e.resolvedPath,
      parentPath: e.parentPath,
      inclusiveMs: e.durationMs,
      exclusiveMs: e.durationMs,  // will be adjusted below
      cached: e.cached,
      isNodeModule: e.isNodeModule,
      isBuiltin: e.isBuiltin,
      children: [],
      depth: 0,
    }))

    // Build a lookup by resolvedPath for fast parent finding
    const byPath = new Map<string, ModuleNode[]>()
    for (const node of nodes) {
      const existing = byPath.get(node.resolvedPath) ?? []
      existing.push(node)
      byPath.set(node.resolvedPath, existing)
    }

    // Wire children to their parent node
    const roots: ModuleNode[] = []
    for (const node of nodes) {
      if (node.parentPath === '<entry>') {
        roots.push(node)
        continue
      }

      const parentNodes = byPath.get(node.parentPath)
      if (parentNodes && parentNodes.length > 0) {
        // Attach to the most recent parent occurrence (last in list)
        parentNodes[parentNodes.length - 1].children.push(node)
      } else {
        // Parent not found (e.g. native addon or dynamic require edge) —
        // treat as root so it still appears in the output
        roots.push(node)
      }
    }

    // Compute exclusive time bottom-up (post-order DFS)
    const computeExclusive = (node: ModuleNode): void => {
      for (const child of node.children) {
        computeExclusive(child)
      }
      const childrenInclusiveSum = node.children.reduce(
        (sum, c) => sum + c.inclusiveMs,
        0
      )
      // Exclusive time can't be negative due to measurement imprecision —
      // clamp to 0
      node.exclusiveMs = Math.max(0, node.inclusiveMs - childrenInclusiveSum)
    }

    for (const root of roots) {
      computeExclusive(root)
    }

    // Assign depth via BFS
    const assignDepth = (node: ModuleNode, depth: number): void => {
      node.depth = depth
      for (const child of node.children) {
        assignDepth(child, depth + 1)
      }
    }
    for (const root of roots) {
      assignDepth(root, 0)
    }

    return roots
  }

  /**
   * Flatten the tree into a list (pre-order DFS).
   */
  private flatten(nodes: ModuleNode[]): ModuleNode[] {
    const result: ModuleNode[] = []
    const visit = (node: ModuleNode): void => {
      result.push(node)
      for (const child of node.children) {
        visit(child)
      }
    }
    for (const node of nodes) {
      visit(node)
    }
    return result
  }

  /**
   * Reset — useful for testing multiple startups in the same process.
   */
  reset(): void {
    this.events = []
    this.startTime = performance.now()
    if (this.histogram) {
      this.histogram.reset()
      this.histogram.enable()
    }
  }

  /** Expose raw events for testing */
  getRawEvents(): ModuleLoadEvent[] {
    return [...this.events]
  }
}

// Singleton — the hook in cjs.ts imports this directly
export const tracer = new Tracer()