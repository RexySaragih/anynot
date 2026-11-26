import { formatCoveragePercent } from './coverage.js';
import type { AnyKind, Confidence, Finding, TypeCoverage } from './types.js';
import { UNKNOWN_FALLBACK } from './types.js';

const CONFIDENCE_ORDER: Confidence[] = ['high', 'medium', 'low'];
const ANY_CARET = '^^^';
const KIND_ORDER: AnyKind[] = [
  'annotation',
  'parameter',
  'return',
  'assertion',
  'generic',
  'rest',
  'implicit',
  'jsdoc',
];

export interface ReportOptions {
  coverage?: TypeCoverage;
}

export function reportHuman(
  findings: Finding[],
  stream: NodeJS.WritableStream = process.stdout,
  options: ReportOptions = {},
): void {
  if (findings.length === 0) {
    stream.write('No findings.\n');
    if (options.coverage) {
      stream.write(`Type coverage: ${formatCoveragePercent(options.coverage)}\n`);
    }
    return;
  }

  const grouped = groupFindingsByFile(findings);
  for (const [file, fileFindings] of grouped) {
    stream.write(`${file}\n`);
    for (const finding of fileFindings) {
      stream.write(formatGroupedFinding(finding));
      stream.write('\n');
    }
    stream.write('\n');
  }

  stream.write(formatSummary(findings, options.coverage));
  stream.write('\n');
}

export function reportJson(
  findings: Finding[],
  stream: NodeJS.WritableStream = process.stdout,
  options: ReportOptions = {},
): void {
  const payload = {
    findings: findings.map((finding) => ({
      id: finding.id,
      file: finding.file,
      line: finding.line,
      column: finding.column,
      kind: finding.kind,
      symbolName: finding.symbolName,
      snippet: finding.snippet,
      implicit: finding.implicit ?? false,
      suggestion: finding.suggestion
        ? {
            type: finding.suggestion.typeText,
            confidence: finding.suggestion.confidence,
            why: finding.suggestion.why,
            evidence: finding.suggestion.evidence,
            assignable: finding.suggestion.assignable,
          }
        : undefined,
      safeSuggestion: finding.safeSuggestion
        ? {
            type: finding.safeSuggestion.typeText,
            confidence: finding.safeSuggestion.confidence,
            why: finding.safeSuggestion.why,
            evidence: finding.safeSuggestion.evidence,
            assignable: finding.safeSuggestion.assignable,
          }
        : undefined,
      fixable: finding.fixable ?? false,
      rootCause: finding.rootCause,
    })),
    summary: summarize(findings, options.coverage),
  };

  stream.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function formatFinding(finding: Finding): string {
  const location = `${finding.file}:${finding.line}:${finding.column}`;
  const header = `${location}  ${formatKindLabel(finding)}`;
  return formatFindingBody(header, finding, '  ');
}

function formatGroupedFinding(finding: Finding): string {
  const header = `  ${finding.line}:${finding.column}  ${formatKindLabel(finding)}`;
  return formatFindingBody(header, finding, '    ');
}

function formatFindingBody(header: string, finding: Finding, indent: string): string {
  const lines = [header, `${indent}${finding.snippet}`];
  const caret = formatCaretLine(finding, indent);
  if (caret) {
    lines.push(caret);
  }

  if (!finding.suggestion) {
    return lines.join('\n');
  }

  const { typeText, confidence, why } = finding.suggestion;
  let suggestionLine = `${indent}suggested: ${typeText}  (${confidence}, ${why})`;
  if (finding.safeSuggestion && finding.safeSuggestion.typeText !== typeText) {
    suggestionLine += ` | safe: ${finding.safeSuggestion.typeText}`;
  }
  lines.push(suggestionLine);
  return lines.join('\n');
}

export function formatSummary(findings: Finding[], coverage?: TypeCoverage): string {
  const summary = summarize(findings, coverage);
  const headline = [
    `${summary.total} finding${summary.total === 1 ? '' : 's'}`,
    `${summary.fixable} fixable (--fix)`,
    `${summary.needReview} need review`,
    `${summary.unknown} → unknown`,
  ].join(' · ');

  const kindParts = KIND_ORDER.filter((kind) => (summary.kinds[kind] ?? 0) > 0).map(
    (kind) => `${kindLabel(kind)} ${summary.kinds[kind]}`,
  );

  const lines = [headline];
  if (kindParts.length > 0) {
    lines.push(`Kinds: ${kindParts.join(' · ')}`);
  }
  if (coverage) {
    lines.push(
      `Type coverage: ${formatCoveragePercent(coverage)}` +
        ` (${coverage.typed}/${coverage.total})`,
    );
  }
  return lines.join('\n');
}

export interface ReportSummary extends Record<Confidence, number> {
  total: number;
  fixable: number;
  needReview: number;
  unknown: number;
  kinds: Partial<Record<AnyKind, number>>;
  coverage?: TypeCoverage;
}

export function summarize(findings: Finding[], coverage?: TypeCoverage): ReportSummary {
  const summary: ReportSummary = {
    high: 0,
    medium: 0,
    low: 0,
    total: findings.length,
    fixable: 0,
    needReview: 0,
    unknown: 0,
    kinds: {},
    coverage,
  };

  for (const finding of findings) {
    const confidence = finding.suggestion?.confidence ?? 'low';
    summary[confidence] += 1;
    summary.kinds[finding.kind] = (summary.kinds[finding.kind] ?? 0) + 1;

    const bucket = classifyFindingBucket(finding);
    summary[bucket] += 1;
  }

  return summary;
}

export function exitCodeForFindings(findings: Finding[]): number {
  return findings.length > 0 ? 1 : 0;
}

export function groupFindingsByFile(findings: Finding[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = map.get(finding.file) ?? [];
    list.push(finding);
    map.set(finding.file, list);
  }

  for (const list of map.values()) {
    list.sort(compareFindingsForReport);
  }

  return map;
}

function compareFindingsForReport(a: Finding, b: Finding): number {
  const fixA = a.fixable ? 0 : 1;
  const fixB = b.fixable ? 0 : 1;
  if (fixA !== fixB) {
    return fixA - fixB;
  }

  const confA = CONFIDENCE_ORDER.indexOf(a.suggestion?.confidence ?? 'low');
  const confB = CONFIDENCE_ORDER.indexOf(b.suggestion?.confidence ?? 'low');
  if (confA !== confB) {
    return confA - confB;
  }

  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.column - b.column;
}

function classifyFindingBucket(finding: Finding): 'fixable' | 'needReview' | 'unknown' {
  if (finding.fixable) {
    return 'fixable';
  }
  const typeText = finding.suggestion?.typeText?.trim();
  if (!typeText || typeText === UNKNOWN_FALLBACK) {
    return 'unknown';
  }
  return 'needReview';
}

function formatKindLabel(finding: Finding): string {
  const kind = kindLabel(finding.kind);
  const implicit = finding.implicit ? ' (implicit)' : '';
  if (finding.symbolName) {
    return `${kind} "${finding.symbolName}"${implicit}`;
  }
  return `${kind}${implicit}`;
}

function kindLabel(kind: AnyKind): string {
  return kind === 'parameter' ? 'param' : kind;
}

function formatCaretLine(finding: Finding, indent: string): string | undefined {
  const offset = resolveAnyOffset(finding);
  if (offset === undefined || offset < 0) {
    return undefined;
  }
  return `${indent}${' '.repeat(offset)}${ANY_CARET}`;
}

function resolveAnyOffset(finding: Finding): number | undefined {
  if (finding.snippetAnyOffset !== undefined && finding.snippetAnyOffset >= 0) {
    return finding.snippetAnyOffset;
  }
  const index = finding.snippet.toLowerCase().indexOf('any');
  return index >= 0 ? index : undefined;
}
