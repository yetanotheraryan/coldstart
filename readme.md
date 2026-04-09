<div align="center">

# coldstart

**Profile Node.js startup one module load at a time.**

<div>
![NPM Version](https://img.shields.io/npm/v/coldstart?style=flat-square&color=CB3837&label=npm)
![GitHub package.json version](https://img.shields.io/github/package-json/v/yetanotheraryan/coldstart?style=flat-square&color=0f172a&label=version)
![GitHub last commit](https://img.shields.io/github/last-commit/yetanotheraryan/coldstart?style=flat-square&color=6366f1)
![GitHub contributors](https://img.shields.io/github/contributors/yetanotheraryan/coldstart?style=flat-square&color=0ea5e9)
![GitHub forks](https://img.shields.io/github/forks/yetanotheraryan/coldstart?style=flat-square&color=8b5cf6)
![GitHub Repo stars](https://img.shields.io/github/stars/yetanotheraryan/coldstart?style=flat-square&color=f59e0b)
![GitHub License](https://img.shields.io/github/license/yetanotheraryan/coldstart?style=flat-square&color=22c55e)

</div>

</div>

`coldstart` is a zero-dependency startup profiler for Node.js that instruments CommonJS and ESM startup loading, reconstructs the dependency tree, and points at the modules that actually slow boot time down.

Terminal tree, JSON, and self-contained flamegraph output are included.

It is designed for questions like:

- Why did startup go from `300ms` to `900ms`?
- Which dependency chain is dominating boot?
- Is the time going into my code or `node_modules`?
- Which modules are slow themselves vs slow only because of their children?
- Is startup blocking the event loop?

## Highlights

- Times every CommonJS `require()` with `performance.now()`
- Traces ESM startup loads through Node's loader hooks
- Builds a parent → child module load tree
- Computes inclusive and exclusive time per module
- Tracks builtins like `fs`, `path`, and `http`
- Measures event loop delay during startup with `perf_hooks`
- Ships a terminal report, JSON report, and self-contained HTML flamegraph
- Has no runtime dependencies

## Status

What works today:

- CommonJS startup profiling
- ESM startup profiling
- CLI profiling
- programmatic API
- text report
- JSON report
- single-file flamegraph HTML export

What does not work yet:

- dynamic `import()` tracing

## Requirements

- Node.js `18+`
- Node.js `18.19+` for ESM tracing through the loader hook path

## Installation

```bash
npm install coldstart
```

If you are working in this repository directly:

```bash
npm install
npm run build
```

## Quick Start

### CLI

Profile a Node app:

```bash
coldstart server.js
```

Profile an ESM entry:

```bash
coldstart server.mjs
```

Pass Node flags through `-- node ...`:

```bash
coldstart -- node --trace-warnings server.js
```

Print JSON instead of the text tree:

```bash
coldstart --json server.js
```

If you are running from this repo before publishing:

```bash
node dist/cli.js server.js
```

### Programmatic API

```ts
import { monitor, renderTextReport } from 'coldstart'

const done = monitor()

require('./bootstrap')
require('./server')

const report = done()
console.log(renderTextReport(report))
```

### Preload Mode

If you want just the loader patch:

```bash
node --require coldstart/register server.js
```

For ESM or mixed apps, prefer:

```bash
node --import coldstart/register server.mjs
```

From this repo:

```bash
node --require ./dist/register.js server.js
```

```bash
node --import ./dist/register.mjs server.mjs
```


For ESM:

```bash
node dist/cli.js -- node --input-type=module -e "await import('./dist/index.mjs')"
```

Or:

```bash
node dist/cli.js -- node -e "require('express'); require('sequelize')"
```

If all you test is `fs`, `path`, or `http`, seeing `0ms` is expected.

## Example Output

```text

coldstart — 847ms total startup

  ┌─ express          234ms  ████████████░░░░░░░░
  │  ├─ body-parser    89ms  █████░░░░░░░░░░░░░░░
  │  ├─ qs             12ms  █░░░░░░░░░░░░░░░░░░░
  │  └─ path-to-regex   8ms  ░░░░░░░░░░░░░░░░░░░░
  ├─ sequelize        401ms  █████████████████████  ⚠ slow
  │  ├─ pg            203ms  ███████████░░░░░░░░░
  │  └─ lodash         98ms  █████░░░░░░░░░░░░░░░
  └─ dotenv             4ms  ░░░░░░░░░░░░░░░░░░░░

event loop max 42ms, p99 17ms, mean 4.3ms
modules 312 total, 59 cached
time split 286ms first-party, 503ms node_modules

```

Color thresholds in the text reporter:

- green: under `20ms`
- yellow: `20ms` to `100ms`
- red: over `100ms`

## CLI Usage

```bash
coldstart [--json] [--color] [--no-color] app.js [args...]
coldstart [--json] [--color] [--no-color] -- node [node-flags...] app.js [args...]
```

Examples:

```bash
coldstart app.js
coldstart app.js --port 3000
coldstart --json app.js
coldstart -- node --inspect app.js
```

What the CLI does:

1. spawns your app in a child Node process
2. preloads `coldstart/register`
3. lets the app run normally
4. collects the startup report on exit
5. prints either text or JSON

## Programmatic API

### `monitor()`

Starts a fresh measurement and returns a function that finalizes the report.

```ts
import { monitor } from 'coldstart'

const done = monitor()
const report = done()
```

### `report()`

Returns the current report immediately.

```ts
import { report } from 'coldstart'

const startupReport = report()
```

This is mainly useful if you already enabled the hook separately.

### `renderTextReport(report, options?)`

Returns the terminal report as a string.

```ts
import { renderTextReport } from 'coldstart'

console.log(renderTextReport(report))
```

Options:

- `color?: boolean`
- `barWidth?: number`
- `showSummary?: boolean`

### `renderJsonReport(report, options?)`

Returns the report as JSON.

```ts
import { renderJsonReport } from 'coldstart'

process.stdout.write(renderJsonReport(report))
```

Options:

- `pretty?: boolean`

### `renderFlamegraphHtml(report)`

Returns a self-contained HTML flamegraph.

```ts
import { renderFlamegraphHtml } from 'coldstart'
import { writeFileSync } from 'fs'

writeFileSync('coldstart.html', renderFlamegraphHtml(report))
```

Open the generated file in a browser to inspect the startup timeline visually.

## How It Works

`coldstart` records raw startup load events from both the CommonJS loader and the ESM loader hook path.

For CommonJS:

- the request is resolved
- the parent module is tracked
- wall-clock load time is measured with `performance.now()`
- cache hits are recorded
- builtins are recorded as dependency edges

For ESM:

- module resolution is captured through the loader `resolve` hook
- module execution completion is tracked through the loader `load` hook
- timing is bridged back to the main tracer through a message channel

After startup, the tracer converts those raw events into:

- a tree of module loads
- a flat list sorted by inclusive time
- a slowest list sorted by exclusive time
- summary stats for total startup, cached loads, event loop blocking, first-party time, and `node_modules` time

## Understanding the Numbers

Each module node includes both `inclusiveMs` and `exclusiveMs`.

Use `inclusiveMs` to answer:

- Which subtree made startup slow?
- Which dependency chain dominates boot time?

Use `exclusiveMs` to answer:

- Which module itself is slow?
- Where is the actual initialization work happening?

Rule of thumb:

- high inclusive, low exclusive: the module mostly pulls in slow children
- high exclusive: the module itself is expensive

## Report Shape

```ts
interface StartupReport {
  totalStartupMs: number
  eventLoop: {
    maxBlockMs: number
    meanBlockMs: number
    p99BlockMs: number
  }
  tree: ModuleNode[]
  flat: ModuleNode[]
  slowest: ModuleNode[]
  nodeModuleTime: number
  firstPartyTime: number
  totalModulesLoaded: number
  cachedModulesCount: number
}
```

```ts
interface ModuleNode {
  id: string
  request: string
  resolvedPath: string
  parentPath: string
  inclusiveMs: number
  exclusiveMs: number
  cached: boolean
  isNodeModule: boolean
  isBuiltin: boolean
  children: ModuleNode[]
  depth: number
}
```

## Troubleshooting

### Why do builtins like `fs`, `path`, or `http` show `0ms`?

Because builtins are not loaded from disk like normal package files. They are still useful to record as dependency edges, but their measured cost is usually effectively zero.

### Why do I mostly see builtin modules?

Your test is probably too small. Try profiling real modules instead:

```bash
coldstart -- node -e "require('typescript')"
```

or:

```bash
coldstart app.js
```

where `app.js` loads real package or first-party code.

### Why do I not see ESM imports?

Make sure you are on Node `18.19+`. The ESM path depends on `module.register()` and Node's loader hooks.

Also note that current support is for startup ESM loading. Dynamic `import()` tracing is still not implemented.

### Why is the CLI output short when my app keeps running?

The CLI prints the report when the child process exits. It is intended for startup profiling runs, not long-lived always-on monitoring.

If you need more control, use the programmatic API and decide when to call `done()`.

### Why do cached modules appear at all?

Because cached loads still describe the startup dependency graph. In text output, noisy zero-cost cached builtin rows are collapsed to keep the tree readable.

## Development

Build:

```bash
npm run build
```

Type-check:

```bash
npx tsc -p tsconfig.json
```

Smoke test:

```bash
node dist/cli.js -- node -e "require('typescript')"
```

ESM smoke test:

```bash
node dist/cli.js -- node --input-type=module -e "await import('./dist/index.mjs')"
```

Programmatic smoke test:

```bash
node -e "const { monitor, renderTextReport } = require('./dist/index.js'); const done = monitor(); require('typescript'); console.log(renderTextReport(done()));"
```

## Why This Exists

Startup regressions are easy to introduce and easy to miss.

A single heavy dependency, synchronous work in module scope, or a deep require chain can quietly add hundreds of milliseconds before your app is ready. `coldstart` makes that visible fast.

## License

MIT
