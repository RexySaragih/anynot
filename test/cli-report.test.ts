import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { runAnynot } from '../src/cli.js';
import { exitCodeForFindings, formatFinding, reportJson } from '../src/report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHASE1 = path.join(HERE, 'fixtures/phase1');
const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function captureStdio(run: () => number): { code: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stdout += chunk.toString();
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      (cb as () => void)();
    }
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stderr += chunk.toString();
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      (cb as () => void)();
    }
    return true;
  }) as typeof process.stderr.write;

  try {
    const code = run();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

describe('Report and CI exit codes', () => {
  describe('when findings exist', () => {
    it('should format human output and exit 1', () => {
      // Given
      const result = analyze({ cwd: PHASE1 });

      // When
      const formatted = formatFinding(result.findings[0]!);

      // Then
      expect(formatted).toContain(result.findings[0]!.file);
      expect(formatted).toMatch(/\d+:\d+/);
      expect(exitCodeForFindings(result.findings)).toBe(1);
    });
  });

  describe('when json reporter is used', () => {
    it('should emit stable ids and suggestions', () => {
      // Given
      const result = analyze({ cwd: PHASE1 });
      let output = '';
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          output += chunk.toString();
          callback();
        },
      });

      // When
      reportJson(result.findings, stream);
      const payload = JSON.parse(output);

      // Then
      expect(payload.findings.length).toBe(result.findings.length);
      expect(payload.findings[0].id).toBeTruthy();
      expect(payload.summary.total).toBe(result.findings.length);
    });
  });

  describe('when there are no findings', () => {
    it('should exit 0', () => {
      expect(exitCodeForFindings([])).toBe(0);
    });
  });
});

describe('CLI progress with machine output', () => {
  describe('when --json is used', () => {
    it('should keep stdout as valid JSON while writing progress to stderr', () => {
      // Given / When
      const { code, stdout, stderr } = captureStdio(() => runAnynot(PHASE1, { json: true }));

      // Then
      expect(code).toBe(1);
      const payload = JSON.parse(stdout);
      expect(payload.summary.total).toBeGreaterThan(0);
      expect(stderr).toMatch(/Loading tsconfig/);
      expect(stderr).toMatch(/Scanning files for any/);
      expect(stderr).toMatch(/Inferring suggestions/);
      expect(stderr).toMatch(/Done — \d+ findings?/);
      expect(stdout.trimStart().startsWith('{')).toBe(true);
    });
  });

  describe('when tsconfig is missing', () => {
    it('should report a clear error on stderr and exit 2', () => {
      // Given / When
      const { code, stdout, stderr } = captureStdio(() =>
        runAnynot(PHASE1, { tsconfig: 'missing-tsconfig.json', json: true }),
      );

      // Then
      expect(code).toBe(2);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/tsconfig not found/i);
    });
  });

  describe('when --out is used with --json', () => {
    it('should write JSON to the file and leave stdout empty', () => {
      // Given
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anynot-out-'));
      TEMP_DIRS.push(tempDir);
      const outFile = path.join(tempDir, 'reports', 'anynot-report.json');

      // When
      const { code, stdout, stderr } = captureStdio(() =>
        runAnynot(PHASE1, { json: true, out: outFile }),
      );

      // Then
      expect(code).toBe(1);
      expect(stdout).toBe('');
      expect(fs.existsSync(outFile)).toBe(true);
      const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      expect(payload.summary.total).toBeGreaterThan(0);
      expect(stderr).toMatch(/wrote report to/);
    });
  });
});
