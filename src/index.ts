import './cjs'
import { tracer, type StartupReport, type ModuleLoadEvent, type ModuleNode } from './tracer'
import { renderTextReport, type TextReporterOptions } from './reporter/text'
import { renderJsonReport, type JsonReporterOptions } from './reporter/json'
import { renderFlamegraphHtml } from './reporter/flamegraph'

export type { StartupReport, ModuleLoadEvent, ModuleNode, TextReporterOptions, JsonReporterOptions }

export function monitor(): () => StartupReport {
  tracer.reset()
  return () => tracer.report()
}

export function report(): StartupReport {
  return tracer.report()
}

export { renderTextReport, renderJsonReport, renderFlamegraphHtml }
