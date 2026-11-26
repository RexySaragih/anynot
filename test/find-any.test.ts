import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHASE1 = path.join(HERE, 'fixtures/phase1');

describe('Find explicit any', () => {
  describe('when a sample project contains every explicit any form', () => {
    it('should report every explicit any location', () => {
      // Given
      const result = analyze({
        cwd: PHASE1,
        skipInference: true,
      });

      // When
      const kinds = result.findings.map((finding) => finding.kind).sort();
      const snippets = result.findings.map((finding) => finding.snippet);

      // Then
      expect(result.findings.length).toBeGreaterThanOrEqual(10);
      expect(kinds).toEqual(
        expect.arrayContaining([
          'annotation',
          'return',
          'parameter',
          'assertion',
          'generic',
          'rest',
        ]),
      );

      expect(snippets.some((snippet) => snippet.includes('annotated: any'))).toBe(true);
      expect(snippets.some((snippet) => snippet.includes('returnsAny(): any'))).toBe(true);
      expect(snippets.some((snippet) => snippet.includes('payload: any'))).toBe(true);
      expect(snippets.some((snippet) => snippet.includes('as any'))).toBe(true);
      expect(snippets.some((snippet) => snippet.includes('any[]'))).toBe(true);
      expect(snippets.some((snippet) => snippet.includes('Promise<any>'))).toBe(true);
      expect(snippets.some((snippet) => snippet.includes('Record<string, any>'))).toBe(true);
      expect(snippets.some((snippet) => snippet.includes('...args: any[]'))).toBe(true);
      expect(snippets.some((snippet) => snippet.includes('value: any'))).toBe(true);

      for (const finding of result.findings) {
        expect(finding.id).toMatch(/^[a-f0-9]{12}$/);
        expect(finding.line).toBeGreaterThan(0);
        expect(finding.column).toBeGreaterThan(0);
        expect(finding.file).toContain('sample.ts');
      }
    });
  });
});
