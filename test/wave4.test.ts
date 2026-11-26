import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { filterNewFindings, loadBaseline, updateBaseline } from '../src/baseline.js';
import { runAnynot } from '../src/cli.js';
import { exitCodeForFindings } from '../src/report.js';
import { reportGithub } from '../src/reporters/github.js';
import { reportSarif, toSarif } from '../src/reporters/sarif.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WAVE4 = path.join(HERE, 'fixtures/wave4');

function captureStdout(run: () => void): string {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stream.write(chunk);
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      (cb as () => void)();
    }
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

describe('Wave 4 JSDoc any detection', () => {
  describe('when source has @type / @param / @returns any', () => {
    it('should report jsdoc findings alongside explicit any', () => {
      // Given / When
      const result = analyze({
        cwd: WAVE4,
        include: ['jsdoc.ts'],
        skipInference: true,
      });

      // Then
      const jsdoc = result.findings.filter((finding) => finding.kind === 'jsdoc');
      expect(jsdoc.length).toBeGreaterThanOrEqual(2);
      expect(
        jsdoc.some(
          (finding) => finding.snippet.includes('@type') || finding.snippet.includes('{any}'),
        ),
      ).toBe(true);
      expect(result.findings.some((finding) => finding.kind === 'annotation')).toBe(true);
    });
  });
});

describe('Wave 4 baseline filtering', () => {
  describe('when baseline lists older finding IDs', () => {
    it('should only fail CI on new finding IDs', () => {
      // Given
      const result = analyze({
        cwd: WAVE4,
        include: ['baseline-sample.ts'],
        skipInference: true,
      });
      expect(result.findings.length).toBeGreaterThanOrEqual(2);

      const known = result.findings.slice(0, -1);
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anynot-baseline-'));
      const baselinePath = path.join(tmpDir, 'anynot-baseline.json');
      updateBaseline(baselinePath, known);

      // When
      const baseline = loadBaseline(baselinePath);
      const novel = filterNewFindings(result.findings, baseline);

      // Then
      expect(novel).toHaveLength(result.findings.length - known.length);
      expect(novel.every((finding) => !baseline.ids.includes(finding.id))).toBe(true);
      expect(exitCodeForFindings(novel)).toBe(1);
      expect(exitCodeForFindings(filterNewFindings(known, baseline))).toBe(0);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('when --update-baseline is used via CLI', () => {
    it('should write baseline and exit 0 when only baselined IDs remain', () => {
      // Given
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anynot-cli-baseline-'));
      const fixtureFile = path.join(tmpDir, 'sample.ts');
      const tsconfig = path.join(tmpDir, 'tsconfig.json');
      const baselinePath = path.join(tmpDir, 'anynot-baseline.json');
      fs.writeFileSync(fixtureFile, 'export const x: any = 1;\n', 'utf8');
      fs.writeFileSync(
        tsconfig,
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true },
          include: ['./**/*'],
        }),
        'utf8',
      );

      // When — seed baseline
      const seedCode = runAnynot(tmpDir, {
        updateBaseline: true,
        baseline: baselinePath,
        json: true,
      });

      // Then — after baseline, same findings are filtered → exit 0
      const afterCode = runAnynot(tmpDir, {
        baseline: baselinePath,
        json: true,
      });

      expect(seedCode).toBe(0);
      expect(afterCode).toBe(0);
      expect(fs.existsSync(baselinePath)).toBe(true);
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
      expect(baseline.ids.length).toBeGreaterThan(0);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});

describe('Wave 4 SARIF reporter', () => {
  describe('when findings are emitted as SARIF', () => {
    it('should produce a schema-shaped SARIF 2.1.0 document', () => {
      // Given
      const result = analyze({
        cwd: WAVE4,
        include: ['baseline-sample.ts'],
        skipInference: true,
      });

      // When
      const log = toSarif(result.findings);
      let printed = '';
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          printed += chunk.toString();
          callback();
        },
      });
      reportSarif(result.findings, stream);

      // Then
      expect(log.$schema).toContain('sarif-2.1.0');
      expect(log.version).toBe('2.1.0');
      expect(log.runs).toHaveLength(1);
      expect(log.runs[0]!.tool.driver.name).toBe('anynot');
      expect(log.runs[0]!.results.length).toBe(result.findings.length);
      expect(
        log.runs[0]!.results[0]!.locations[0]!.physicalLocation.region.startLine,
      ).toBeGreaterThan(0);
      expect(JSON.parse(printed).version).toBe('2.1.0');
    });
  });
});

describe('Wave 4 GitHub reporter', () => {
  describe('when findings are emitted as workflow annotations', () => {
    it('should print ::error/::warning commands', () => {
      // Given
      const result = analyze({
        cwd: WAVE4,
        include: ['baseline-sample.ts'],
        skipInference: true,
      });

      // When
      let printed = '';
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          printed += chunk.toString();
          callback();
        },
      });
      reportGithub(result.findings, stream);

      // Then
      expect(printed).toMatch(/::(error|warning) file=/);
      expect(printed).toContain(`line=${result.findings[0]!.line}`);
      expect(printed).toContain('::notice::anynot found');
    });
  });
});

describe('Wave 4 imported-any root cause', () => {
  describe('when exported any mirrors an untyped package import', () => {
    it('should attach an imported-any rootCause hint', () => {
      // Given / When
      const result = analyze({
        cwd: WAVE4,
        include: ['imported-any.ts'],
        skipInference: true,
      });

      // Then
      const exportedAny = result.findings.find((finding) => finding.file.includes('imported-any'));
      expect(exportedAny).toBeTruthy();
      expect(exportedAny!.rootCause).toMatch(/imported any from package untyped-dep/);
    });
  });
});

describe('Wave 4 CLI reporters', () => {
  describe('when --reporter sarif is passed', () => {
    it('should exit non-zero and emit SARIF on stdout', () => {
      // Given / When
      const output = captureStdout(() => {
        const code = runAnynot(WAVE4, {
          include: 'baseline-sample.ts',
          reporter: 'sarif',
        });
        expect(code).toBe(1);
      });

      // Then
      const payload = JSON.parse(output);
      expect(payload.version).toBe('2.1.0');
      expect(payload.runs[0].results.length).toBeGreaterThan(0);
    });
  });
});
