import type { ModuleNode, StartupReport } from '../tracer'

interface FlamegraphFrame {
  name: string
  value: number
  depth: number
  start: number
  end: number
  path: string
  isBuiltin: boolean
  isNodeModule: boolean
  cached: boolean
}

export function renderFlamegraphHtml(report: StartupReport): string {
  const total = Math.max(report.totalStartupMs, 1)
  const frames = buildFrames(report.tree)
  const maxDepth = frames.reduce((depth, frame) => Math.max(depth, frame.depth), 0)
  const payload = JSON.stringify({
    totalStartupMs: report.totalStartupMs,
    eventLoop: report.eventLoop,
    totalModulesLoaded: report.totalModulesLoaded,
    cachedModulesCount: report.cachedModulesCount,
    frames,
    maxDepth,
  })

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>coldstart flamegraph</title>
  <style>
    :root {
      --bg: #f7f2e8;
      --panel: rgba(255, 252, 246, 0.92);
      --border: #d8c9ae;
      --text: #2c2418;
      --muted: #6b5c48;
      --grid: rgba(117, 95, 63, 0.15);
      --builtin: #8fb8a8;
      --node-module: #e09f5a;
      --first-party: #c8553d;
      --cached: #b9b0a3;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Avenir Next", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(232, 171, 96, 0.28), transparent 28%),
        radial-gradient(circle at top right, rgba(114, 155, 121, 0.18), transparent 25%),
        linear-gradient(180deg, #fbf6ee 0%, var(--bg) 100%);
    }

    .page {
      max-width: 1280px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }

    .hero {
      display: grid;
      gap: 10px;
      margin-bottom: 20px;
    }

    h1 {
      margin: 0;
      font-size: clamp(28px, 4vw, 48px);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }

    .subtle {
      color: var(--muted);
      font-size: 14px;
    }

    .stats {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin: 18px 0 24px;
    }

    .stat {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px 14px;
      min-width: 150px;
      backdrop-filter: blur(6px);
    }

    .stat strong {
      display: block;
      font-size: 20px;
      margin-bottom: 4px;
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 14px;
      font-size: 13px;
      color: var(--muted);
    }

    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .swatch {
      width: 12px;
      height: 12px;
      border-radius: 3px;
      border: 1px solid rgba(0, 0, 0, 0.08);
    }

    .chart {
      position: relative;
      overflow: auto;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 14px;
      box-shadow: 0 20px 50px rgba(102, 75, 44, 0.08);
    }

    .chart-grid {
      position: absolute;
      inset: 14px;
      pointer-events: none;
      background-image:
        linear-gradient(to right, var(--grid) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(117, 95, 63, 0.08) 1px, transparent 1px);
      background-size: 10% 100%, 100% 32px;
    }

    #flamegraph {
      position: relative;
      min-width: 960px;
    }

    .frame {
      position: absolute;
      height: 26px;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid rgba(44, 36, 24, 0.08);
      cursor: default;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22);
    }

    .frame span {
      display: block;
      padding: 5px 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 12px;
      font-weight: 600;
    }

    .tooltip {
      position: fixed;
      z-index: 10;
      max-width: 320px;
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(44, 36, 24, 0.96);
      color: #fff9ef;
      font-size: 12px;
      line-height: 1.4;
      pointer-events: none;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 120ms ease, transform 120ms ease;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.25);
    }

    .tooltip.visible {
      opacity: 1;
      transform: translateY(0);
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="hero">
      <div class="subtle">Node.js startup profile</div>
      <h1>coldstart flamegraph</h1>
      <div class="subtle">Inclusive module load time laid out across startup from left to right.</div>
    </div>

    <div class="stats">
      <div class="stat"><strong>${formatMs(report.totalStartupMs)}</strong><span>Total startup</span></div>
      <div class="stat"><strong>${report.totalModulesLoaded}</strong><span>Modules loaded</span></div>
      <div class="stat"><strong>${report.cachedModulesCount}</strong><span>Cached requires</span></div>
      <div class="stat"><strong>${formatMs(report.eventLoop.maxBlockMs)}</strong><span>Max event loop block</span></div>
    </div>

    <div class="legend">
      <span><i class="swatch" style="background: var(--first-party)"></i>First-party</span>
      <span><i class="swatch" style="background: var(--node-module)"></i>node_modules</span>
      <span><i class="swatch" style="background: var(--builtin)"></i>Builtins</span>
      <span><i class="swatch" style="background: var(--cached)"></i>Cached</span>
    </div>

    <div class="chart">
      <div class="chart-grid"></div>
      <div id="flamegraph"></div>
    </div>
  </div>

  <div id="tooltip" class="tooltip"></div>

  <script>
    const data = ${payload};
    const total = Math.max(data.totalStartupMs || ${total}, 1);
    const rowHeight = 32;
    const flamegraph = document.getElementById('flamegraph');
    const tooltip = document.getElementById('tooltip');
    flamegraph.style.height = ((data.maxDepth + 1) * rowHeight) + 'px';

    const colorFor = (frame) => {
      if (frame.cached) return 'var(--cached)';
      if (frame.isBuiltin) return 'var(--builtin)';
      if (frame.isNodeModule) return 'var(--node-module)';
      return 'var(--first-party)';
    };

    for (const frame of data.frames) {
      const element = document.createElement('div');
      const width = Math.max((frame.value / total) * 100, 0.25);
      element.className = 'frame';
      element.style.left = (frame.start / total) * 100 + '%';
      element.style.top = (frame.depth * rowHeight) + 'px';
      element.style.width = width + '%';
      element.style.background = colorFor(frame);
      element.innerHTML = '<span>' + escapeHtml(frame.name) + '</span>';
      element.addEventListener('mousemove', (event) => {
        tooltip.innerHTML =
          '<strong>' + escapeHtml(frame.name) + '</strong><br>' +
          'Inclusive: ' + formatMs(frame.value) + '<br>' +
          'Range: ' + formatMs(frame.start) + ' - ' + formatMs(frame.end) + '<br>' +
          'Path: ' + escapeHtml(frame.path);
        tooltip.style.left = (event.clientX + 14) + 'px';
        tooltip.style.top = (event.clientY + 14) + 'px';
        tooltip.classList.add('visible');
      });
      element.addEventListener('mouseleave', () => {
        tooltip.classList.remove('visible');
      });
      flamegraph.appendChild(element);
    }

    function formatMs(value) {
      if (!Number.isFinite(value)) return '0ms';
      if (value >= 100) return Math.round(value) + 'ms';
      if (value >= 10) return value.toFixed(1).replace(/\\.0$/, '') + 'ms';
      return value.toFixed(2).replace(/0+$/, '').replace(/\\.$/, '') + 'ms';
    }

    function escapeHtml(value) {
      return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }
  </script>
</body>
</html>`
}

function buildFrames(nodes: ModuleNode[]): FlamegraphFrame[] {
  const frames: FlamegraphFrame[] = []

  for (const node of nodes) {
    walk(node, 0, formatLabel(node))
  }

  return frames

  function walk(node: ModuleNode, start: number, trail: string): number {
    const end = start + node.inclusiveMs
    frames.push({
      name: formatLabel(node),
      value: node.inclusiveMs,
      depth: node.depth,
      start,
      end,
      path: trail,
      isBuiltin: node.isBuiltin,
      isNodeModule: node.isNodeModule,
      cached: node.cached,
    })

    let childOffset = start
    for (const child of node.children) {
      childOffset = walk(child, childOffset, `${trail} -> ${formatLabel(child)}`)
    }

    return end
  }
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
  return base.length > 0 ? base : (node.request || node.resolvedPath)
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

function formatMs(value: number): string {
  if (!Number.isFinite(value)) {
    return '0ms'
  }

  if (value >= 100) {
    return `${Math.round(value)}ms`
  }

  if (value >= 10) {
    return `${value.toFixed(1).replace(/\.0$/, '')}ms`
  }

  return `${value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}ms`
}
