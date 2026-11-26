import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { runAnynot } from '../src/cli.js';
import { applyFixes, previewFixes } from '../src/fix.js';
import { isIncluded, matchGlob } from '../src/globs.js';
import { reportHuman } from '../src/report.js';
import type { Finding } from '../src/types.js';
import { HIGH_CONFIDENCE } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLISION = path.join(HERE, 'fixtures/collision');

function captureStderr(run: () => number): { code: number; stderr: string } {
  let stderr = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
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
    return { code, stderr };
  } finally {
    process.stderr.write = originalWrite;
  }
}

function captureReport(write: (stream: NodeJS.WritableStream) => void): string {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  write(stream);
  return output;
}

function makeFixableFinding(overrides: Partial<Finding>): Finding {
  return {
    id: 'escape-test',
    file: '../outside.ts',
    line: 1,
    column: 14,
    kind: 'annotation',
    snippet: 'export const value: any = 1;',
    nodeStart: 20,
    nodeEnd: 23,
    suggestion: {
      typeText: 'number',
      confidence: HIGH_CONFIDENCE,
      why: 'test',
      assignable: true,
    },
    fixable: true,
    ...overrides,
  };
}

describe('Named-type collision', () => {
  describe('when two files declare the same interface name', () => {
    it('should prefer the same-file named type for the suggestion', () => {
      // Given / When
      const result = analyze({ cwd: COLLISION });
      const person = result.findings.find((finding) => finding.snippet.includes('person: any'));

      // Then — named type resolves to same-file User {id,name}, not other-user's {email,role}
      expect(person?.suggestion).toBeDefined();
      expect(person!.suggestion!.typeText).toBe('User');
      expect(['high', 'medium']).toContain(person!.suggestion!.confidence);
      expect(person!.file).toContain('same-file-user');
    });
  });
});

describe('Corrupt / invalid baseline', () => {
  describe('when baseline JSON is corrupt', () => {
    it('should exit 2 with an invalid-baseline message and not crash', () => {
      // Given
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anynot-bad-baseline-'));
      fs.writeFileSync(path.join(tmpDir, 'sample.ts'), 'export const x: any = 1;\n', 'utf8');
      fs.writeFileSync(
        path.join(tmpDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true },
          include: ['./**/*'],
        }),
        'utf8',
      );
      const baselinePath = path.join(tmpDir, 'broken-baseline.json');
      fs.writeFileSync(baselinePath, '{ not valid json !!', 'utf8');

      // When
      const { code, stderr } = captureStderr(() =>
        runAnynot(tmpDir, {
          baseline: baselinePath,
          json: true,
        }),
      );

      // Then
      expect(code).toBe(2);
      expect(stderr.toLowerCase()).toMatch(/invalid baseline/);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('when baseline shape is invalid', () => {
    it('should exit 2 mentioning invalid baseline', () => {
      // Given
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anynot-shape-baseline-'));
      fs.writeFileSync(path.join(tmpDir, 'sample.ts'), 'export const x: any = 1;\n', 'utf8');
      fs.writeFileSync(
        path.join(tmpDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true },
          include: ['./**/*'],
        }),
        'utf8',
      );
      const baselinePath = path.join(tmpDir, 'shape-baseline.json');
      fs.writeFileSync(baselinePath, JSON.stringify({ version: 1, ids: 'not-an-array' }), 'utf8');

      // When
      const { code, stderr } = captureStderr(() =>
        runAnynot(tmpDir, {
          baseline: baselinePath,
          json: true,
        }),
      );

      // Then
      expect(code).toBe(2);
      expect(stderr.toLowerCase()).toMatch(/invalid baseline/);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});

describe('--fix path confinement', () => {
  describe('when a finding file escapes the confine root', () => {
    it('should skip the finding and not write outside the root', () => {
      // Given
      const confineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'anynot-confine-'));
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anynot-outside-'));
      const outsideFile = path.join(outsideDir, 'outside.ts');
      const original = 'export const value: any = 1;\n';
      fs.writeFileSync(outsideFile, original, 'utf8');

      const relativeEscape = path.relative(confineRoot, outsideFile).split(path.sep).join('/');
      expect(relativeEscape.startsWith('..')).toBe(true);

      const finding = makeFixableFinding({
        file: relativeEscape,
        nodeStart: original.indexOf('any'),
        nodeEnd: original.indexOf('any') + 3,
      });

      // When
      const preview = previewFixes([finding], confineRoot, confineRoot);
      const fixResult = applyFixes([finding], confineRoot, confineRoot);

      // Then
      expect(preview.fixed).toBe(0);
      expect(preview.files).toHaveLength(0);
      expect(preview.fileDiffs).toHaveLength(0);
      expect(preview.skipped).toBeGreaterThanOrEqual(1);

      expect(fixResult.fixed).toBe(0);
      expect(fixResult.files).toHaveLength(0);
      expect(fs.readFileSync(outsideFile, 'utf8')).toBe(original);

      fs.rmSync(confineRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });
  });
});

describe('Glob include/exclude', () => {
  describe('when matching with * and **', () => {
    it('should match single-segment and recursive patterns', () => {
      // Given
      const cwd = '/project';

      // When / Then
      expect(matchGlob('src/a.ts', 'src/*.ts', cwd)).toBe(true);
      expect(matchGlob('src/nested/a.ts', 'src/*.ts', cwd)).toBe(false);
      expect(matchGlob('src/nested/a.ts', 'src/**/*.ts', cwd)).toBe(true);
      expect(matchGlob('src/a.ts', 'src/**/*.ts', cwd)).toBe(true);
      expect(matchGlob('lib/a.ts', 'src/**/*.ts', cwd)).toBe(false);
    });
  });

  describe('when exclude and include both match', () => {
    it('should let exclude win over include', () => {
      // Given
      const cwd = '/project';
      const file = 'src/skip-me.ts';

      // When / Then
      expect(isIncluded(file, cwd, ['src/**/*.ts'], undefined)).toBe(true);
      expect(isIncluded(file, cwd, ['src/**/*.ts'], ['src/skip-me.ts'])).toBe(false);
      expect(isIncluded(file, cwd, ['src/**/*.ts'], ['src/**'])).toBe(false);
      expect(isIncluded('src/keep.ts', cwd, ['src/**/*.ts'], ['src/skip-me.ts'])).toBe(true);
    });
  });
});

describe('Human empty-state copy', () => {
  describe('when there are no findings', () => {
    it('should report No findings. instead of the old any-only copy', () => {
      // Given / When
      const output = captureReport((stream) => {
        reportHuman([], stream);
      });

      // Then
      expect(output).toBe('No findings.\n');
      expect(output).not.toContain('No explicit any found.');
    });
  });
});
