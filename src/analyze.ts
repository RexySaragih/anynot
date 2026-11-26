import path from 'node:path';
import type ts from 'typescript';
import { computeTypeCoverage, mergeCoverage } from './coverage.js';
import { enrichImportedAnyRootCause, findExplicitAny, findImplicitAny } from './findAny.js';
import { isIncluded } from './globs.js';
import { attachSuggestions } from './inferType.js';
import { getAnalyzableSourceFiles, type LoadedProgram, loadPrograms } from './loadProgram.js';
import { toRelative } from './paths.js';
import type { AnalyzeOptions, AnalyzeResult, Finding, TypeCoverage } from './types.js';

export function analyze(options: AnalyzeOptions = {}): AnalyzeResult {
  const cwd = options.cwd ?? process.cwd();
  const report = options.onProgress;

  report?.('Starting analysis…');
  const programs = loadPrograms(cwd, options.tsconfig, report);
  const allFindings: Finding[] = [];
  const coverageParts: TypeCoverage[] = [];
  let primary = programs[0];

  for (const loaded of programs) {
    primary = primary ?? loaded;
    const { findings, coverage } = analyzeProgram(loaded, options);
    allFindings.push(...findings);
    coverageParts.push(coverage);
  }

  if (!primary) {
    throw new Error('No TypeScript program loaded');
  }

  const deduped = dedupeFindings(allFindings);
  deduped.sort(compareFindings);

  return {
    findings: deduped,
    programRoot: primary.rootDir,
    tsconfigPath: primary.tsconfigPath,
    coverage: mergeCoverage(...coverageParts),
  };
}

function analyzeProgram(
  loaded: LoadedProgram,
  options: AnalyzeOptions,
): { findings: Finding[]; coverage: TypeCoverage } {
  const { program, checker, rootDir } = loaded;
  const report = options.onProgress;
  const sourceFiles = getAnalyzableSourceFiles(program);
  const sourceFileByPath = new Map<string, ts.SourceFile>();
  const findings: Finding[] = [];
  const includedFiles: ts.SourceFile[] = [];

  report?.('Scanning files for any…');
  for (const sourceFile of sourceFiles) {
    const relative = toRelative(sourceFile.fileName, rootDir);
    if (!isIncluded(relative, rootDir, options.include, options.exclude)) {
      continue;
    }

    const normalized = path.normalize(sourceFile.fileName);
    sourceFileByPath.set(normalized, sourceFile);
    sourceFileByPath.set(sourceFile.fileName, sourceFile);
    sourceFileByPath.set(relative, sourceFile);
    sourceFileByPath.set(path.resolve(rootDir, relative), sourceFile);

    includedFiles.push(sourceFile);
    findings.push(...findExplicitAny(sourceFile, rootDir));
  }

  if (options.includeImplicit) {
    const implicit = findImplicitAny(program, rootDir).filter((finding) =>
      isIncluded(finding.file, rootDir, options.include, options.exclude),
    );
    findings.push(...implicit);
  }

  report?.('Computing type coverage…');
  const coverage = computeTypeCoverage(program, includedFiles);

  const withRootCause = enrichImportedAnyRootCause(
    findings,
    program,
    checker,
    sourceFileByPath,
    rootDir,
  );

  if (options.skipInference) {
    return { findings: withRootCause, coverage };
  }

  const count = withRootCause.length;
  report?.(`Inferring suggestions (${count} finding${count === 1 ? '' : 's'})…`);

  return {
    findings: attachSuggestions(withRootCause, program, checker, sourceFileByPath, rootDir),
    coverage,
  };
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const byId = new Map<string, Finding>();
  for (const finding of findings) {
    if (!byId.has(finding.id)) {
      byId.set(finding.id, finding);
    }
  }
  return [...byId.values()];
}

function compareFindings(a: Finding, b: Finding): number {
  const fileCmp = a.file.localeCompare(b.file);
  if (fileCmp !== 0) {
    return fileCmp;
  }
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.column - b.column;
}
