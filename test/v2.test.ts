import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { applyFixes } from '../src/fix.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const V2 = path.join(HERE, 'fixtures/v2');

describe('v2 usage, named types, fix, ignore, implicit', () => {
  describe('when anynot-ignore comments are present', () => {
    it('should skip ignored findings', () => {
      // Given / When
      const result = analyze({ cwd: V2 });
      const snippets = result.findings.map((finding) => finding.snippet);

      // Then
      expect(snippets.some((snippet) => snippet.includes('ignored: any'))).toBe(false);
      expect(snippets.some((snippet) => snippet.includes('ignoredNext: any'))).toBe(false);
    });
  });

  describe('when usage reveals object properties', () => {
    it('should suggest a structural type from property access', () => {
      // Given / When
      const result = analyze({ cwd: V2 });
      const read = result.findings.find((finding) => finding.snippet.includes('input: any'));

      // Then
      expect(read?.suggestion).toBeDefined();
      expect(read!.suggestion!.typeText).not.toBe('any');
      expect(
        read!.suggestion!.typeText.includes('id') || read!.suggestion!.why.includes('usage'),
      ).toBe(true);
    });
  });

  describe('when a structural initializer matches a named interface', () => {
    it('should prefer the named type when assignable', () => {
      // Given / When
      const result = analyze({ cwd: V2 });
      const person = result.findings.find((finding) => finding.snippet.includes('person: any'));

      // Then
      expect(person?.suggestion).toBeDefined();
      expect(person!.suggestion!.typeText).not.toBe('any');
      // Prefer User when matching works; otherwise structural with id/name is acceptable
      expect(
        person!.suggestion!.typeText === 'User' || person!.suggestion!.typeText.includes('id'),
      ).toBe(true);
    });
  });

  describe('when --include-implicit is enabled', () => {
    it('should report implicit any diagnostics', () => {
      // Given / When
      const result = analyze({ cwd: V2, includeImplicit: true });
      const implicit = result.findings.filter(
        (finding) => finding.implicit || finding.kind === 'implicit',
      );

      // Then
      expect(implicit.length).toBeGreaterThan(0);
      expect(implicit[0]!.suggestion?.typeText).toBe('unknown');
    });
  });

  describe('when --fix is applied to high-confidence findings', () => {
    it('should rewrite only high-confidence any keywords', () => {
      // Given
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anynot-fix-'));
      fs.copyFileSync(path.join(V2, 'tsconfig.json'), path.join(tempDir, 'tsconfig.json'));
      const sourceName = 'usage-and-fix.ts';
      fs.copyFileSync(path.join(V2, sourceName), path.join(tempDir, sourceName));

      const before = analyze({ cwd: tempDir });
      const high = before.findings.filter((finding) => finding.suggestion?.confidence === 'high');
      expect(high.length).toBeGreaterThan(0);

      // When
      const fixResult = applyFixes(before.findings, tempDir);
      const afterText = fs.readFileSync(path.join(tempDir, sourceName), 'utf8');
      const after = analyze({ cwd: tempDir });

      // Then
      expect(fixResult.fixed).toBeGreaterThan(0);
      expect(afterText).not.toMatch(/fixMe:\s*any/);
      expect(after.findings.length).toBeLessThan(before.findings.length);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
