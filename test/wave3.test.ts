import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import {
  formatFinding,
  formatSummary,
  groupFindingsByFile,
  reportHuman,
  reportJson,
} from '../src/report.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WAVE3 = path.join(HERE, 'fixtures/wave3');

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

describe('Wave 3 grouped human report', () => {
  describe('when findings span multiple files', () => {
    it('should group by file, show symbol names, carets, and summary buckets', () => {
      // Given
      const result = analyze({ cwd: WAVE3 });

      // When
      const output = captureReport((stream) => {
        reportHuman(result.findings, stream, { coverage: result.coverage });
      });
      const payload = result.findings;
      const payloadFinding = payload.find((finding) => finding.symbolName === 'payload');
      const grouped = groupFindingsByFile(result.findings);

      // Then
      expect(grouped.size).toBeGreaterThanOrEqual(2);
      expect(output).toMatch(/^alpha\.ts$/m);
      expect(output).toMatch(/^beta\.ts$/m);
      expect(output).toContain('param "payload"');
      expect(payloadFinding?.snippetAnyOffset).toBeGreaterThanOrEqual(0);

      const formatted = formatFinding(payloadFinding!);
      expect(formatted).toContain('^^^');
      const snippetLine = formatted.split('\n').find((line) => line.includes('payload: any'));
      const caretLine = formatted.split('\n').find((line) => line.includes('^^^'));
      expect(snippetLine).toBeDefined();
      expect(caretLine).toBeDefined();
      const anyIndex = snippetLine!.indexOf('any');
      const caretIndex = caretLine!.indexOf('^^^');
      expect(caretIndex).toBe(anyIndex);

      expect(output).toMatch(
        /\d+ findings? · \d+ fixable \(--fix\) · \d+ need review · \d+ → unknown/,
      );
      expect(output).toMatch(/Kinds:/);
      expect(output).toMatch(/Type coverage: \d+(\.\d+)?%/);

      const summary = formatSummary(result.findings, result.coverage);
      expect(summary).toContain('fixable (--fix)');
      expect(summary).toContain('Type coverage:');
    });
  });

  describe('when sorting within a file', () => {
    it('should put fixable findings before lower-confidence ones', () => {
      // Given / When
      const result = analyze({ cwd: WAVE3 });
      const beta = groupFindingsByFile(result.findings).get('beta.ts');

      // Then
      expect(beta).toBeDefined();
      expect(beta!.length).toBeGreaterThan(1);
      const firstFixableIndex = beta!.findIndex((finding) => finding.fixable);
      if (firstFixableIndex >= 0) {
        for (let i = 0; i < firstFixableIndex; i += 1) {
          expect(beta![i]!.fixable).toBeFalsy();
        }
        for (let i = firstFixableIndex + 1; i < beta!.length; i += 1) {
          if (!beta![i]!.fixable) {
            // once we leave the fixable block, remaining may be non-fixable
            const trailing = beta!.slice(i);
            expect(trailing.every((finding) => !finding.fixable)).toBe(true);
            break;
          }
        }
      }

      const confRank = { high: 0, medium: 1, low: 2 } as const;
      for (let i = 1; i < beta!.length; i += 1) {
        const prev = beta![i - 1]!;
        const curr = beta![i]!;
        const prevFix = prev.fixable ? 0 : 1;
        const currFix = curr.fixable ? 0 : 1;
        if (prevFix !== currFix) {
          expect(prevFix).toBeLessThanOrEqual(currFix);
          continue;
        }
        const prevConf = confRank[prev.suggestion?.confidence ?? 'low'];
        const currConf = confRank[curr.suggestion?.confidence ?? 'low'];
        expect(prevConf).toBeLessThanOrEqual(currConf);
      }
    });
  });
});

describe('Wave 3 JSON report and coverage', () => {
  describe('when json reporter runs', () => {
    it('should include evidence, dual suggestions, fixable, and coverage', () => {
      // Given
      const result = analyze({ cwd: WAVE3 });

      // When
      const output = captureReport((stream) => {
        reportJson(result.findings, stream, { coverage: result.coverage });
      });
      const payload = JSON.parse(output);

      // Then
      expect(payload.summary.total).toBe(result.findings.length);
      expect(payload.summary.fixable).toBeGreaterThanOrEqual(0);
      expect(payload.summary.needReview).toBeGreaterThanOrEqual(0);
      expect(payload.summary.unknown).toBeGreaterThanOrEqual(0);
      expect(payload.summary.kinds).toBeDefined();
      expect(payload.summary.coverage).toBeDefined();
      expect(payload.summary.coverage.percentage).toBeGreaterThanOrEqual(0);
      expect(payload.summary.coverage.percentage).toBeLessThanOrEqual(100);
      expect(payload.summary.coverage.total).toBeGreaterThan(0);

      const withSuggestion = payload.findings.find(
        (finding: { suggestion?: { evidence?: string[] } }) => finding.suggestion,
      );
      expect(withSuggestion).toBeDefined();
      expect(withSuggestion.fixable).toBeDefined();
      if (withSuggestion.suggestion?.evidence) {
        expect(Array.isArray(withSuggestion.suggestion.evidence)).toBe(true);
      }
      if (withSuggestion.safeSuggestion) {
        expect(withSuggestion.safeSuggestion.type).toBeTruthy();
      }
    });
  });

  describe('when analyze computes coverage', () => {
    it('should report a percentage reflecting non-any identifiers', () => {
      // Given / When
      const result = analyze({ cwd: WAVE3 });

      // Then
      expect(result.coverage.total).toBeGreaterThan(0);
      expect(result.coverage.typed + result.coverage.anyCount).toBe(result.coverage.total);
      expect(result.coverage.percentage).toBeGreaterThan(0);
      expect(result.coverage.percentage).toBeLessThanOrEqual(100);
    });
  });
});

describe('Wave 3 ignore-by-id', () => {
  describe('when anynot-ignore lists a finding id', () => {
    it('should suppress only that finding', () => {
      // Given
      const before = analyze({ cwd: WAVE3 });
      const target = before.findings.find((finding) => finding.snippet.includes('suppressTarget'));
      expect(target).toBeDefined();

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anynot-wave3-'));
      fs.copyFileSync(path.join(WAVE3, 'tsconfig.json'), path.join(tempDir, 'tsconfig.json'));
      fs.copyFileSync(path.join(WAVE3, 'alpha.ts'), path.join(tempDir, 'alpha.ts'));
      const betaSource = fs.readFileSync(path.join(WAVE3, 'beta.ts'), 'utf8');
      const withIgnore = betaSource.replace(
        'export const suppressTarget: any = 99;',
        `export const suppressTarget: any = 99; // anynot-ignore ${target!.id}`,
      );
      fs.writeFileSync(path.join(tempDir, 'beta.ts'), withIgnore);

      // When
      const after = analyze({ cwd: tempDir });

      // Then
      expect(after.findings.some((finding) => finding.id === target!.id)).toBe(false);
      expect(after.findings.some((finding) => finding.snippet.includes('loose: any'))).toBe(true);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('when anynot-ignore id appears elsewhere in the file', () => {
    it('should suppress that finding by file-scoped id', () => {
      // Given
      const before = analyze({ cwd: WAVE3 });
      const target = before.findings.find((finding) => finding.snippet.includes('suppressTarget'));
      expect(target).toBeDefined();

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anynot-wave3-id-'));
      fs.copyFileSync(path.join(WAVE3, 'tsconfig.json'), path.join(tempDir, 'tsconfig.json'));
      fs.copyFileSync(path.join(WAVE3, 'alpha.ts'), path.join(tempDir, 'alpha.ts'));
      const betaSource = fs.readFileSync(path.join(WAVE3, 'beta.ts'), 'utf8');
      // Append so line numbers (and finding ids) for existing anys stay stable.
      const withIgnore = `${betaSource}\n// anynot-ignore ${target!.id}\n`;
      fs.writeFileSync(path.join(tempDir, 'beta.ts'), withIgnore);

      // When
      const after = analyze({ cwd: tempDir });

      // Then
      expect(after.findings.some((finding) => finding.id === target!.id)).toBe(false);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
