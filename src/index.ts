export { analyze } from './analyze.js';
export type { BaselineFile } from './baseline.js';
export {
  filterNewFindings,
  loadBaseline,
  updateBaseline,
} from './baseline.js';
export { main, runAnynot } from './cli.js';
export { computeTypeCoverage, formatCoveragePercent, mergeCoverage } from './coverage.js';
export {
  classifyAnyKind,
  enrichImportedAnyRootCause,
  findExplicitAny,
  findImplicitAny,
} from './findAny.js';
export { applyFixes, formatDryRun, isFixable, previewFixes } from './fix.js';
export { collectIgnoredIds, isIgnoredAt } from './ignore.js';
export { attachSuggestions } from './inferType.js';
export { getAnalyzableSourceFiles, loadProgram, loadPrograms } from './loadProgram.js';
export {
  exitCodeForFindings,
  formatFinding,
  formatSummary,
  groupFindingsByFile,
  reportHuman,
  reportJson,
  summarize,
} from './report.js';
export { formatGithubAnnotation, reportGithub } from './reporters/github.js';
export { reportSarif, toSarif } from './reporters/sarif.js';
export type {
  AnalyzeOptions,
  AnalyzeResult,
  AnyKind,
  Confidence,
  DryRunReplacement,
  DryRunResult,
  Finding,
  FixResult,
  Suggestion,
  TypeCoverage,
} from './types.js';
