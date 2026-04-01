import type { ModuleNode, StartupReport } from '../tracer'

const BAR_WIDTH = 18
const ANSI_RESET = '\x1b[0m'
const ANSI_RED = '\x1b[31m'
const ANSI_YELLOW = '\x1b[33m'
const ANSI_GREEN = '\x1b[32m'
const ANSI_DIM = '\x1b[2m'

export interface TextReporterOptions {
  color?: boolean
  barWidth?: number
  showSummary?: boolean
}

export function renderTextReport(
  report: StartupReport,
  options: TextReporterOptions = {}
): string {
  const color = options.color ?? true
  const barWidth = options.barWidth ?? BAR_WIDTH
  const showSummary = options.showSummary ?? true
  const displayTree = collapseDisplayNoise(report.tree)
  const maxInclusiveMs = Math.max(
    1,
    ...report.flat
      .filter(node => !node.cached)
      .map(node => node.inclusiveMs),
  )

  const lines: string[] = [
    `coldstart - ${formatDuration(report.totalStartupMs)} total startup`,
    '',
  ]

  for (let index = 0; index < displayTree.length; index += 1) {
    const isLastRoot = index === displayTree.length - 1
    const root = displayTree[index]
    lines.push(...renderNode(root, '', isLastRoot, maxInclusiveMs, barWidth, color))
  }

  if (showSummary) {
    if (displayTree.length > 0) {
      lines.push('')
    }

    lines.push(
      `${dim('event loop')} max ${formatDuration(report.eventLoop.maxBlockMs)}, p99 ${formatDuration(report.eventLoop.p99BlockMs)}, mean ${formatDuration(report.eventLoop.meanBlockMs)}`,
      `${dim('modules')} ${report.totalModulesLoaded} total, ${report.cachedModulesCount} cached`,
      `${dim('time split')} ${formatDuration(report.firstPartyTime)} first-party, ${formatDuration(report.nodeModuleTime)} node_modules`,
    )
  }

  return lines.join('\n')

  function dim(value: string): string {
    return colorize(value, ANSI_DIM, color)
  }
}

function collapseDisplayNoise(nodes: ModuleNode[]): ModuleNode[] {
  const result: ModuleNode[] = []
  const seen = new Set<string>()

  for (const node of nodes) {
    const collapsedChildren = collapseDisplayNoise(node.children)
    const collapsedNode: ModuleNode = {
      ...node,
      children: collapsedChildren,
    }

    if (collapsedNode.inclusiveMs === 0 && collapsedNode.children.length === 0) {
      continue
    }

    if (shouldCollapseBuiltinNode(collapsedNode)) {
      const key = [
        collapsedNode.request,
        collapsedNode.depth,
      ].join('|')

      if (seen.has(key)) {
        continue
      }

      seen.add(key)
    }

    if (isAnonymousNode(collapsedNode)) {
      result.push(...collapsedNode.children)
      continue
    }

    result.push(collapsedNode)
  }

  return result
}

function shouldCollapseBuiltinNode(node: ModuleNode): boolean {
  return node.isBuiltin && node.cached && node.inclusiveMs === 0 && node.children.length === 0
}

function isAnonymousNode(node: ModuleNode): boolean {
  const label = formatLabel(node)
  return label === '.' || label === '..'
}

function renderNode(
  node: ModuleNode,
  prefix: string,
  isLast: boolean,
  maxInclusiveMs: number,
  barWidth: number,
  color: boolean
): string[] {
  const branch = prefix.length === 0 ? (isLast ? '└─ ' : '┌─ ') : `${prefix}${isLast ? '└─ ' : '├─ '}`
  const nextPrefix = prefix.length === 0 ? (isLast ? '   ' : '│  ') : `${prefix}${isLast ? '   ' : '│  '}`
  const label = formatLabel(node)
  const duration = formatDuration(node.inclusiveMs).padStart(6)
  const durationColor = getDurationColor(node.inclusiveMs)
  const bar = renderBar(node.inclusiveMs, maxInclusiveMs, barWidth)
  const suffix = node.inclusiveMs >= 100 ? `  ${colorize('! slow', ANSI_RED, color)}` : ''

  const line = `${branch}${label.padEnd(18)} ${colorize(duration, durationColor, color)}  ${colorize(bar, durationColor, color)}${suffix}`
  const lines = [line]

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]
    const isLastChild = index === node.children.length - 1
    lines.push(...renderNode(child, nextPrefix, isLastChild, maxInclusiveMs, barWidth, color))
  }

  return lines
}

function formatLabel(node: ModuleNode): string {
  if (node.isBuiltin) {
    return node.request.replace(/^node:/, '')
  }

  if (node.isNodeModule) {
    return packageNameFromRequest(node.request)
  }

  const normalizedPath = normalizeModulePath(node)
  const segments = normalizedPath.split('/')
  const base = segments[segments.length - 1] ?? ''
  return base.length > 0 ? base : node.request
}

function normalizeModulePath(node: ModuleNode): string {
  if (looksLikeRelativeRequest(node.request)) {
    return node.request.replace(/\\/g, '/')
  }

  if (node.resolvedPath.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(node.resolvedPath).pathname).replace(/\\/g, '/')
    } catch {
      return node.resolvedPath.replace(/\\/g, '/')
    }
  }

  return node.resolvedPath.replace(/\\/g, '/')
}

function looksLikeRelativeRequest(request: string): boolean {
  return request.startsWith('./') || request.startsWith('../') || request.startsWith('/')
}

function packageNameFromRequest(request: string): string {
  if (request.startsWith('@')) {
    const [scope, name] = request.split('/')
    return name ? `${scope}/${name}` : request
  }

  const [name] = request.split('/')
  return name || request
}

function renderBar(durationMs: number, maxInclusiveMs: number, barWidth: number): string {
  const filled = Math.max(1, Math.round((durationMs / maxInclusiveMs) * barWidth))
  return `${'█'.repeat(Math.min(barWidth, filled))}${'░'.repeat(Math.max(0, barWidth - filled))}`
}

function formatDuration(valueMs: number): string {
  if (!Number.isFinite(valueMs)) {
    return '0ms'
  }

  if (valueMs >= 1000) {
    return `${Math.round(valueMs)}ms`
  }

  if (valueMs >= 100) {
    return `${Math.round(valueMs)}ms`
  }

  if (valueMs >= 10) {
    return `${valueMs.toFixed(1).replace(/\.0$/, '')}ms`
  }

  return `${valueMs.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}ms`
}

function getDurationColor(durationMs: number): string {
  if (durationMs > 100) {
    return ANSI_RED
  }

  if (durationMs >= 20) {
    return ANSI_YELLOW
  }

  return ANSI_GREEN
}

function colorize(value: string, code: string, enabled: boolean): string {
  if (!enabled) {
    return value
  }

  return `${code}${value}${ANSI_RESET}`
}
