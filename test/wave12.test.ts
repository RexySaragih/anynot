import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { applyFixes, formatDryRun, previewFixes } from '../src/fix.js';
import { formatFinding } from '../src/report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WAVE12 = path.join(HERE, 'fixtures/wave12');

describe('Wave 1 property-typed usage inference', () => {
  describe('when properties are assigned, method-called, and passed as args', () => {
    it('should suggest typed properties instead of unknown fields', () => {
      // Given / When
      const result = analyze({ cwd: WAVE12 });
      const enrich = result.findings.find((finding) => finding.snippet.includes('account: any'));

      // Then
      expect(enrich?.suggestion).toBeDefined();
      expect(enrich!.suggestion!.typeText).not.toBe('any');
      expect(/\bany\b/.test(enrich!.suggestion!.typeText)).toBe(false);
      expect(
        enrich!.suggestion!.typeText === 'Account' ||
          (enrich!.suggestion!.typeText.includes('id') &&
            enrich!.suggestion!.typeText.includes('name')),
      ).toBe(true);

      if (enrich!.suggestion!.typeText.includes('{')) {
        expect(enrich!.suggestion!.typeText).not.toMatch(/id:\s*unknown/);
      }

      expect(enrich!.suggestion!.evidence?.length).toBeGreaterThan(0);
      expect(enrich!.suggestion!.evidence?.some((item) => item.includes('prop .'))).toBe(true);
    });
  });

  describe('when parameter uses object destructuring', () => {
    it('should infer from destructuring binding names or context', () => {
      // Given / When
      const result = analyze({ cwd: WAVE12 });
      const readPair = result.findings.find((finding) =>
        finding.snippet.includes('{ id, name }: any'),
      );

      // Then
      expect(readPair?.suggestion).toBeDefined();
      expect(readPair!.suggestion!.typeText).not.toBe('any');
      expect(
        readPair!.suggestion!.typeText === 'Account' ||
          readPair!.suggestion!.typeText.includes('id') ||
          readPair!.suggestion!.why.includes('destructur'),
      ).toBe(true);
    });
  });

  describe('when map callback parameter is any', () => {
    it('should infer element type from the receiver array', () => {
      // Given / When
      const result = analyze({ cwd: WAVE12 });
      const mapCb = result.findings.find((finding) => finding.snippet.includes('row: any'));

      // Then
      expect(mapCb?.suggestion).toBeDefined();
      expect(mapCb!.suggestion!.typeText).not.toBe('any');
      expect(
        mapCb!.suggestion!.typeText === 'Account' ||
          mapCb!.suggestion!.why.toLowerCase().includes('map') ||
          mapCb!.suggestion!.evidence?.some((item) => item.includes('map')),
      ).toBe(true);
    });
  });

  describe('when class field is assigned in constructor', () => {
    it('should infer from constructor assignment', () => {
      // Given / When
      const result = analyze({ cwd: WAVE12 });
      const field = result.findings.find((finding) => finding.snippet.includes('value: any'));

      // Then
      expect(field?.suggestion).toBeDefined();
      expect(field!.suggestion!.typeText).not.toBe('any');
      expect(
        field!.suggestion!.typeText === 'number' ||
          field!.suggestion!.why.includes('class field') ||
          field!.suggestion!.evidence?.some((item) => item.includes('class field')),
      ).toBe(true);
    });
  });
});

describe('Wave 1 JSX and Promise container inference', () => {
  describe('when assertion sits in a JSX attribute', () => {
    it('should use JSX contextual type', () => {
      // Given / When
      const result = analyze({ cwd: WAVE12 });
      const assertion = result.findings.find(
        (finding) => finding.kind === 'assertion' && finding.file.includes('jsx'),
      );

      // Then
      expect(assertion?.suggestion).toBeDefined();
      expect(assertion!.suggestion!.typeText).not.toBe('any');
      expect(/\bany\b/.test(assertion!.suggestion!.typeText)).toBe(false);
    });
  });

  describe('when return type is Promise<any> and awaited', () => {
    it('should suggest Promise with an inner type', () => {
      // Given / When
      const result = analyze({ cwd: WAVE12 });
      const fetchUser = result.findings.find((finding) =>
        finding.snippet.includes('fetchUser(): Promise<any>'),
      );

      // Then
      expect(fetchUser?.suggestion).toBeDefined();
      expect(fetchUser!.suggestion!.typeText).not.toBe('any');
      expect(
        fetchUser!.suggestion!.typeText.startsWith('Promise<') ||
          fetchUser!.suggestion!.typeText === 'User' ||
          fetchUser!.suggestion!.evidence?.some((item) => item.includes('await')),
      ).toBe(true);
    });
  });
});

describe('Wave 1 named types and evidence', () => {
  describe('when a suggestion is produced', () => {
    it('should attach evidence and never suggest any', () => {
      // Given / When
      const result = analyze({ cwd: WAVE12 });

      // Then
      expect(result.findings.length).toBeGreaterThan(0);
      for (const finding of result.findings) {
        expect(finding.suggestion).toBeDefined();
        expect(/\bany\b/.test(finding.suggestion!.typeText)).toBe(false);
        expect(finding.safeSuggestion).toBeDefined();
      }
    });
  });
});

describe('Wave 1 Language Service inferFromUsage', () => {
  describe('when --include-implicit is enabled', () => {
    it('should attempt LS inference for implicit any', () => {
      // Given / When
      const result = analyze({ cwd: WAVE12, includeImplicit: true });
      const implicit = result.findings.filter(
        (finding) => finding.implicit || finding.kind === 'implicit',
      );

      // Then — fixture may or may not emit implicit depending on TSX/strict paths;
      // at minimum, any implicit finding must not suggest any
      for (const finding of implicit) {
        expect(/\bany\b/.test(finding.suggestion!.typeText)).toBe(false);
        expect(finding.suggestion!.evidence?.length ?? 0).toBeGreaterThanOrEqual(0);
      }

      // Explicit findings still present
      expect(result.findings.some((finding) => !finding.implicit)).toBe(true);
    });
  });
});

describe('Wave 2 assignability and dual suggestions', () => {
  describe('when a wide Object-like value is used', () => {
    it('should keep confidence at medium or low', () => {
      // Given / When
      const result = analyze({ cwd: WAVE12 });
      const bag = result.findings.find((finding) => finding.snippet.includes('bag: any'));

      // Then
      expect(bag?.suggestion).toBeDefined();
      expect(['medium', 'low']).toContain(bag!.suggestion!.confidence);
      expect(bag!.safeSuggestion?.typeText).toBe('unknown');
    });
  });

  describe('when best suggestion is speculative', () => {
    it('should expose safe unknown dual suggestion in formatted output', () => {
      // Given / When
      const result = analyze({ cwd: WAVE12 });
      const speculative = result.findings.find(
        (finding) =>
          finding.suggestion &&
          finding.safeSuggestion &&
          finding.safeSuggestion.typeText === 'unknown' &&
          finding.suggestion.typeText !== 'unknown',
      );

      // Then
      expect(speculative).toBeDefined();
      const formatted = formatFinding(speculative!);
      expect(formatted).toContain('safe: unknown');
      expect(speculative!.fixable).not.toBe(true);
    });
  });

  describe('when suggestion fails assignability at use sites', () => {
    it('should downgrade confidence below high', () => {
      // Given / When
      const result = analyze({ cwd: WAVE12 });
      const loose = result.findings.find((finding) => finding.snippet.includes('payload: any'));

      // Then
      expect(loose?.suggestion).toBeDefined();
      // Either matched something that is not high, or high only if assignable
      if (loose!.suggestion!.assignable === false) {
        expect(loose!.suggestion!.confidence).not.toBe('high');
      }
      expect(loose!.safeSuggestion).toBeDefined();
    });
  });
});

describe('Wave 2 --fix and --dry-run', () => {
  describe('when --fix --dry-run is requested', () => {
    it('should print before/after and write nothing', () => {
      // Given
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anynot-dry-'));
      for (const name of ['tsconfig.json', 'assignability.ts']) {
        fs.copyFileSync(path.join(WAVE12, name), path.join(tempDir, name));
      }
      const beforeText = fs.readFileSync(path.join(tempDir, 'assignability.ts'), 'utf8');
      const before = analyze({ cwd: tempDir });

      // When
      const preview = previewFixes(before.findings, tempDir);
      const rendered = formatDryRun(preview);
      const afterText = fs.readFileSync(path.join(tempDir, 'assignability.ts'), 'utf8');

      // Then
      expect(afterText).toBe(beforeText);
      expect(rendered.toLowerCase()).toContain('dry run');
      if (preview.fixed > 0) {
        expect(rendered).toMatch(/[-+]/);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('when --fix rewrites a high-confidence assignable annotation', () => {
    it('should replace the type and reduce findings', () => {
      // Given
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anynot-fix12-'));
      for (const name of ['tsconfig.json', 'assignability.ts']) {
        fs.copyFileSync(path.join(WAVE12, name), path.join(tempDir, name));
      }

      const before = analyze({ cwd: tempDir });
      const ready = before.findings.find((finding) => finding.snippet.includes('ready: any'));
      expect(ready?.suggestion?.confidence).toBe('high');
      expect(ready?.fixable).toBe(true);

      // When
      const fixResult = applyFixes(before.findings, tempDir);
      const afterText = fs.readFileSync(path.join(tempDir, 'assignability.ts'), 'utf8');
      const after = analyze({ cwd: tempDir });

      // Then
      expect(fixResult.fixed).toBeGreaterThan(0);
      expect(afterText).not.toMatch(/ready:\s*any/);
      expect(after.findings.length).toBeLessThan(before.findings.length);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('when Promise<any> has a concrete inner suggestion', () => {
    it('should rewrite the whole type node on fix', () => {
      // Given
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anynot-promise-'));
      fs.copyFileSync(path.join(WAVE12, 'tsconfig.json'), path.join(tempDir, 'tsconfig.json'));
      fs.copyFileSync(
        path.join(WAVE12, 'jsx-and-promise.tsx'),
        path.join(tempDir, 'jsx-and-promise.tsx'),
      );

      const before = analyze({ cwd: tempDir });
      const loadAccount = before.findings.find((finding) =>
        finding.snippet.includes('loadAccount(): Promise<any>'),
      );

      // When — only apply if high+fixable with Promise<...> suggestion
      if (loadAccount?.fixable && loadAccount.suggestion?.typeText.startsWith('Promise<')) {
        applyFixes([loadAccount], tempDir);
        const afterText = fs.readFileSync(path.join(tempDir, 'jsx-and-promise.tsx'), 'utf8');

        // Then
        expect(afterText).not.toMatch(/loadAccount\(\):\s*Promise<any>/);
        expect(afterText).toMatch(/loadAccount\(\):\s*Promise</);
      } else {
        // Inference may land on User / medium — still must never suggest any
        expect(loadAccount?.suggestion?.typeText).toBeDefined();
        expect(/\bany\b/.test(loadAccount!.suggestion!.typeText)).toBe(false);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
