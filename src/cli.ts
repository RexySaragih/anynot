#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { cac } from 'cac';
import { analyze } from './analyze.js';
import { filterNewFindings, loadBaseline, updateBaseline } from './baseline.js';
import { type AnynotConfig, ConfigError, loadConfig } from './config.js';
import { applyFixes, formatDryRun, previewFixes } from './fix.js';
import { createProgress, formatMachineDoneSummary, type ProgressReporter } from './progress.js';
import { exitCodeForFindings, reportHuman, reportJson } from './report.js';
import { reportGithub } from './reporters/github.js';
import { reportSarif } from './reporters/sarif.js';
import type { AnyKind, Finding, TypeCoverage } from './types.js';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json') as { version: string };

type ReporterName = 'sarif' | 'github';

interface CliOptions {
  fix?: boolean;
  dryRun?: boolean;
  json?: boolean;
  out?: string;
  tsconfig?: string;
  include?: string | string[];
  exclude?: string | string[];
  includeImplicit?: boolean;
  baseline?: string;
  updateBaseline?: boolean;
  reporter?: string;
  config?: string;
}

interface EffectiveOptions {
  include?: string[];
  exclude?: string[];
  tsconfig?: string;
  includeImplicit: boolean;
  ignoreKinds?: AnyKind[];
  baseline?: string;
  reporter?: ReporterName;
  out?: string;
  json: boolean;
  fix: boolean;
  dryRun: boolean;
  updateBaseline: boolean;
}

export function main(argv: string[] = process.argv): number {
  const cli = cac('anynot');

  cli
    .command('[cwd]', 'Find explicit TypeScript any and suggest replacements')
    .option('--fix', 'Apply high-confidence assignable type replacements')
    .option('--dry-run', 'With --fix, preview replacements without writing')
    .option('--json', 'Emit JSON report (ignored when --reporter is set)')
    .option('--out <path>', 'Write report to a file instead of stdout')
    .option('--reporter <name>', 'Emit sarif (code scanning) or github (workflow annotations)')
    .option('--baseline <path>', 'Only new finding IDs (not in baseline) fail CI')
    .option('--update-baseline', 'Write current finding IDs to --baseline path')
    .option('--tsconfig <path>', 'Path to tsconfig.json')
    .option('--include <glob>', 'Include glob (comma-separated or repeatable)')
    .option('--exclude <glob>', 'Exclude glob (comma-separated or repeatable)')
    .option('--include-implicit', 'Also report implicit any from noImplicitAny')
    .option('--config <path>', 'Path to anynot.json / anynot.jsonc project config')
    .action((cwd: string | undefined, options: CliOptions) => {
      process.exitCode = runAnynot(cwd ?? process.cwd(), options);
    });

  cli.help();
  cli.version(VERSION);

  try {
    cli.parse(argv, { run: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`anynot: ${message}\n`);
    process.exitCode = 2;
  }

  const code = process.exitCode ?? 0;
  return typeof code === 'number' ? code : Number(code) || 0;
}

export function runAnynot(cwd: string, options: CliOptions): number {
  const progress = createProgress();
  try {
    return runAnynotBody(cwd, options, progress);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progress.fail(message);
    return 2;
  }
}

function runAnynotBody(cwd: string, options: CliOptions, progress: ProgressReporter): number {
  const resolvedCwd = path.resolve(cwd);

  let fileConfig: AnynotConfig;
  try {
    ({ config: fileConfig } = loadConfig(resolvedCwd, options.config, (message) => {
      process.stderr.write(`anynot: ${message}\n`);
    }));
  } catch (error) {
    if (error instanceof ConfigError) {
      progress.fail(error.message);
      return 2;
    }
    throw error;
  }

  const effective = mergeCliAndConfig(options, fileConfig);
  const baselinePath = effective.baseline
    ? path.resolve(resolvedCwd, effective.baseline)
    : undefined;
  const outPath = effective.out ? path.resolve(resolvedCwd, effective.out) : undefined;
  const machineOutput = effective.json || !!effective.reporter;

  if (effective.updateBaseline && !baselinePath) {
    progress.fail('--update-baseline requires --baseline <path>');
    return 2;
  }

  const onProgress = (message: string): void => {
    progress.phase(message);
  };

  const analyzeOptions = {
    cwd: resolvedCwd,
    tsconfig: effective.tsconfig,
    include: effective.include,
    exclude: effective.exclude,
    includeImplicit: effective.includeImplicit,
    ignoreKinds: effective.ignoreKinds,
    onProgress,
  };

  let result = analyze(analyzeOptions);

  let findings = result.findings;

  if (effective.fix) {
    if (effective.dryRun) {
      progress.phase('Previewing fixes…');
      const preview = previewFixes(findings, result.programRoot, resolvedCwd);
      progress.done();
      process.stderr.write(formatDryRun(preview));
    } else {
      progress.phase('Applying fixes…');
      const fixResult = applyFixes(findings, result.programRoot, resolvedCwd);
      progress.done(
        `Fixed ${fixResult.fixed}, skipped ${fixResult.skipped}` +
          (fixResult.files.length > 0 ? ` in ${fixResult.files.join(', ')}` : ''),
      );

      progress.phase('Re-analyzing after fixes…');
      result = analyze(analyzeOptions);
      findings = result.findings;
    }
  }

  if (effective.updateBaseline && baselinePath) {
    progress.phase('Updating baseline…');
    updateBaseline(baselinePath, findings, resolvedCwd);
    progress.done(
      `Updated baseline ${path.relative(resolvedCwd, baselinePath) || baselinePath}` +
        ` (${findings.length} id(s))`,
    );
  }

  if (baselinePath && !effective.updateBaseline) {
    progress.phase('Applying baseline…');
  }

  const reportFindings = applyBaselineFilter(findings, baselinePath);

  progress.phase(outPath ? `Writing report to ${path.relative(resolvedCwd, outPath) || outPath}…` : 'Writing report…');
  progress.done(
    machineOutput ? formatMachineDoneSummary(reportFindings, result.coverage) : undefined,
  );

  emitReport(reportFindings, {
    json: effective.json,
    reporter: effective.reporter,
    coverage: result.coverage,
    outPath,
    cwd: resolvedCwd,
  });

  return exitCodeForFindings(reportFindings);
}

function mergeCliAndConfig(cli: CliOptions, file: AnynotConfig): EffectiveOptions {
  const include =
    cli.include !== undefined ? normalizeList(cli.include) : file.include;
  const exclude =
    cli.exclude !== undefined ? normalizeList(cli.exclude) : file.exclude;

  const reporterRaw = cli.reporter !== undefined ? cli.reporter : file.reporter;

  return {
    include,
    exclude,
    tsconfig: cli.tsconfig !== undefined ? cli.tsconfig : file.tsconfig,
    includeImplicit:
      cli.includeImplicit !== undefined ? !!cli.includeImplicit : !!file.includeImplicit,
    ignoreKinds: file.ignoreKinds,
    baseline: cli.baseline !== undefined ? cli.baseline : file.baseline,
    reporter: parseReporter(reporterRaw),
    out: cli.out !== undefined ? cli.out : file.out,
    json: cli.json !== undefined ? !!cli.json : !!file.json,
    fix: !!cli.fix,
    dryRun: !!cli.dryRun,
    updateBaseline: !!cli.updateBaseline,
  };
}

function applyBaselineFilter(findings: Finding[], baselinePath: string | undefined): Finding[] {
  if (!baselinePath) {
    return findings;
  }
  const baseline = loadBaseline(baselinePath);
  return filterNewFindings(findings, baseline);
}

function emitReport(
  findings: Finding[],
  options: {
    json: boolean;
    reporter: ReporterName | undefined;
    coverage?: TypeCoverage;
    outPath?: string;
    cwd: string;
  },
): void {
  const { stream, close } = openReportStream(options.outPath);
  try {
    if (options.reporter === 'sarif') {
      reportSarif(findings, stream);
    } else if (options.reporter === 'github') {
      reportGithub(findings, stream);
    } else {
      const reportOptions = { coverage: options.coverage };
      if (options.json) {
        reportJson(findings, stream, reportOptions);
      } else {
        reportHuman(findings, stream, reportOptions);
      }
    }
  } finally {
    close();
  }

  if (options.outPath) {
    const relative = path.relative(options.cwd, options.outPath) || options.outPath;
    process.stderr.write(`anynot: wrote report to ${relative}\n`);
  }
}

function openReportStream(outPath: string | undefined): {
  stream: NodeJS.WritableStream;
  close: () => void;
} {
  if (!outPath) {
    return {
      stream: process.stdout,
      close: () => undefined,
    };
  }

  let content = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      content += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      callback();
    },
  });

  return {
    stream,
    close: () => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, content, 'utf8');
    },
  };
}

function parseReporter(value: string | undefined): ReporterName | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'sarif' || normalized === 'github') {
    return normalized;
  }
  throw new Error(`Unknown reporter "${value}". Use sarif or github.`);
}

function normalizeList(value: string | string[] | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function samePath(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisFile = path.resolve(fileURLToPath(import.meta.url));
if (entryFile && samePath(entryFile, thisFile)) {
  main();
}
