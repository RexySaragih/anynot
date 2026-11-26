import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHASE2 = path.join(HERE, 'fixtures/phase2');

describe('Suggest replacement types', () => {
  describe('when initializer is a concrete object literal', () => {
    it('should suggest a high-confidence structural or named type', () => {
      // Given / When
      const result = analyze({ cwd: PHASE2 });
      const user = result.findings.find((finding) => finding.snippet.includes('user: any'));

      // Then
      expect(user?.suggestion).toBeDefined();
      expect(user!.suggestion!.confidence).toBe('high');
      expect(user!.suggestion!.typeText).not.toBe('any');
      expect(
        user!.suggestion!.typeText === 'CheckoutPayload' ||
          user!.suggestion!.typeText.includes('id') ||
          user!.suggestion!.typeText.includes('name'),
      ).toBe(true);
    });
  });

  describe('when parameter is passed to a typed call site', () => {
    it('should suggest CheckoutPayload with high or medium confidence', () => {
      // Given / When
      const result = analyze({ cwd: PHASE2 });
      const handle = result.findings.find((finding) => finding.snippet.includes('payload: any'));

      // Then
      expect(handle?.suggestion).toBeDefined();
      expect(['high', 'medium']).toContain(handle!.suggestion!.confidence);
      expect(handle!.suggestion!.typeText).toContain('CheckoutPayload');
    });
  });

  describe('when value comes from JSON.parse', () => {
    it('should fall back to unknown with low confidence', () => {
      // Given / When
      const result = analyze({ cwd: PHASE2 });
      const parsed = result.findings.find((finding) => finding.snippet.includes('parsed: any'));
      const forced = result.findings.find(
        (finding) => finding.snippet.includes('as any') && finding.kind === 'assertion',
      );

      // Then
      expect(parsed?.suggestion?.typeText).toBe('unknown');
      expect(parsed?.suggestion?.confidence).toBe('low');
      expect(forced?.suggestion?.typeText).toBe('unknown');
      expect(forced?.suggestion?.confidence).toBe('low');
    });
  });

  describe('when return expression is concrete', () => {
    it('should suggest a type from the returned value', () => {
      // Given / When
      const result = analyze({ cwd: PHASE2 });
      const getUser = result.findings.find((finding) => finding.snippet.includes('getUser(): any'));

      // Then
      expect(getUser?.suggestion).toBeDefined();
      expect(getUser!.suggestion!.typeText).not.toBe('any');
      expect(['high', 'medium']).toContain(getUser!.suggestion!.confidence);
    });
  });
});
