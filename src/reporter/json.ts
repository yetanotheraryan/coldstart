import type { StartupReport } from '../tracer'

export interface JsonReporterOptions {
  pretty?: boolean
}

export function renderJsonReport(
  report: StartupReport,
  options: JsonReporterOptions = {}
): string {
  return `${JSON.stringify(report, jsonReplacer, options.pretty === false ? 0 : 2)}\n`
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return 0
  }

  return value
}
