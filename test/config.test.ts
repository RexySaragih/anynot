import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { runAnynot } from '../src/cli.js';
import { ConfigError, loadConfig, stripJsonc } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CONFIG = path.join(HERE, 'fixtures/config');
const FIXTURE_PKG = path.join(HERE, 'fixtures/config-pkg');
const FIXTURE_JSONC = path.join(HERE, 'fixtures/config-jsonc');
const FIXTURE_INVALID = path.join(HERE, 'fixtures/config-invalid');
const FIXTURE_KINDS = path.join(HERE, 'fixtures/config-kinds');
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

describe('Project config discovery', () => {
  describe('when anynot.json sets include and ignore', () => {
    it('should analyze only included files and skip ignored globs', () => {
      // Given / When
      const { code, stdout } = captureStdio(() => runAnynot(FIXTURE_CONFIG, {}));
      const payload = JSON.parse(stdout);

      // Then
      expect(code).toBe(1);
      expect(payload.findings).toHaveLength(1);
      expect(payload.findings[0].file).toContain('kept.ts');
      expect(payload.findings.every((f: { file: string }) => !f.file.includes('skipped'))).toBe(
        true,
      );
    });
  });

  describe('when CLI --exclude is passed', () => {
    it('should replace config ignore patterns rather than append', () => {
      // Given / When — exclude nothing from config's ignore; exclude src instead
      const { code, stdout } = captureStdio(() =>
        runAnynot(FIXTURE_CONFIG, { exclude: 'src/**', json: true }),
      );
      const payload = JSON.parse(stdout);

      // Then — config include still applies; src is excluded by CLI replace
      expect(code).toBe(0);
      expect(payload.findings).toHaveLength(0);
    });
  });

  describe('when package.json has an anynot object', () => {
    it('should discover package.json#anynot when no config file exists', () => {
      // Given / When
      const loaded = loadConfig(FIXTURE_PKG);
      const { code, stdout } = captureStdio(() => runAnynot(FIXTURE_PKG, { json: true }));
      const payload = JSON.parse(stdout);

      // Then
      expect(loaded.path).toBe(path.join(FIXTURE_PKG, 'package.json'));
      expect(loaded.config.include).toEqual(['only.ts']);
      expect(code).toBe(1);
      expect(payload.findings).toHaveLength(1);
      expect(payload.findings[0].kind).toBe('annotation');
      expect(payload.findings[0].file).toContain('only.ts');
    });
  });

  describe('when anynot.jsonc is present', () => {
    it('should parse JSONC comments and apply ignore', () => {
      // Given / When
      const { code, stdout } = captureStdio(() => runAnynot(FIXTURE_JSONC, {}));
      const payload = JSON.parse(stdout);

      // Then
      expect(code).toBe(1);
      expect(payload.findings).toHaveLength(1);
      expect(payload.findings[0].file).toContain('kept.ts');
    });
  });

  describe('when --config points at a missing file', () => {
    it('should exit 2 with a clear stderr message', () => {
      // Given / When
      const { code, stderr } = captureStdio(() =>
        runAnynot(FIXTURE_CONFIG, { config: 'missing-anynot.json', json: true }),
      );

      // Then
      expect(code).toBe(2);
      expect(stderr).toMatch(/config not found/i);
    });
  });

  describe('when auto-discovered config is invalid', () => {
    it('should exit 2 instead of silently ignoring', () => {
      // Given / When
      const { code, stderr } = captureStdio(() => runAnynot(FIXTURE_INVALID, { json: true }));

      // Then
      expect(code).toBe(2);
      expect(stderr).toMatch(/invalid config/i);
      expect(() => loadConfig(FIXTURE_INVALID)).toThrow(ConfigError);
    });
  });

  describe('when config sets ignoreKinds', () => {
    it('should drop matching finding kinds while keeping others', () => {
      // Given / When
      const viaCli = captureStdio(() => runAnynot(FIXTURE_KINDS, {}));
      const viaAnalyze = analyze({
        cwd: FIXTURE_KINDS,
        ignoreKinds: ['jsdoc', 'assertion'],
        skipInference: true,
      });

      // Then
      const payload = JSON.parse(viaCli.stdout);
      expect(viaCli.code).toBe(1);
      expect(payload.findings.every((f: { kind: string }) => f.kind === 'annotation')).toBe(true);
      expect(payload.findings.some((f: { kind: string }) => f.kind === 'jsdoc')).toBe(false);
      expect(payload.findings.some((f: { kind: string }) => f.kind === 'assertion')).toBe(false);
      expect(viaAnalyze.findings.every((f) => f.kind === 'annotation')).toBe(true);
    });
  });

  describe('when config has unknown keys', () => {
    it('should warn on stderr and still apply known fields', () => {
      // Given
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anynot-config-warn-'));
      TEMP_DIRS.push(tempDir);
      fs.writeFileSync(
        path.join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ['./**/*.ts'],
        }),
      );
      fs.writeFileSync(path.join(tempDir, 'sample.ts'), 'export const x: any = 1;\n');
      fs.writeFileSync(
        path.join(tempDir, 'anynot.json'),
        JSON.stringify({ json: true, notARealKey: true }),
      );

      // When
      const { code, stdout, stderr } = captureStdio(() => runAnynot(tempDir, {}));

      // Then
      expect(code).toBe(1);
      expect(stderr).toMatch(/unknown config key "notARealKey"/);
      expect(JSON.parse(stdout).findings).toHaveLength(1);
    });
  });
});

describe('JSONC strip', () => {
  describe('when source has line and block comments', () => {
    it('should remove comments outside of strings', () => {
      // Given
      const source = `{
  // line
  "a": "http://x", /* block */
  "b": 1
}`;

      // When
      const parsed = JSON.parse(stripJsonc(source));

      // Then
      expect(parsed).toEqual({ a: 'http://x', b: 1 });
    });
  });
});
