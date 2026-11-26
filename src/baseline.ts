import fs from 'node:fs';
import path from 'node:path';
import { resolveUnderRoot } from './paths.js';
import type { Finding } from './types.js';

export const BASELINE_VERSION = 1;

export interface BaselineFile {
  version: number;
  ids: string[];
}

/**
 * Load a baseline file of known finding IDs.
 * Missing file → empty baseline (all findings are new).
 */
export function loadBaseline(baselinePath: string): BaselineFile {
  const resolved = path.resolve(baselinePath);
  if (!fs.existsSync(resolved)) {
    return { version: BASELINE_VERSION, ids: [] };
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeBaseline(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid baseline at ${resolved}: ${detail}`);
  }
}

/**
 * Keep only findings whose IDs are not in the baseline.
 */
export function filterNewFindings(findings: Finding[], baseline: BaselineFile): Finding[] {
  const known = new Set(baseline.ids);
  return findings.filter((finding) => !known.has(finding.id));
}

/**
 * Write current finding IDs to the baseline path (sorted for stability).
 * Path must resolve under confineRoot (defaults to the baseline file's directory).
 */
export function updateBaseline(
  baselinePath: string,
  findings: Finding[],
  confineRoot?: string,
): BaselineFile {
  const confine = confineRoot ?? path.dirname(path.resolve(baselinePath));
  const resolved = resolveUnderRoot(confine, baselinePath);
  const ids = [...new Set(findings.map((finding) => finding.id))].sort();
  const payload: BaselineFile = {
    version: BASELINE_VERSION,
    ids,
  };

  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function normalizeBaseline(parsed: unknown): BaselineFile {
  if (Array.isArray(parsed)) {
    return {
      version: BASELINE_VERSION,
      ids: parsed.filter((entry): entry is string => typeof entry === 'string'),
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('expected object or string array');
  }

  const record = parsed as Record<string, unknown>;
  const idsRaw = record.ids ?? record.findings;
  if (!Array.isArray(idsRaw)) {
    throw new Error('missing ids array');
  }

  return {
    version: typeof record.version === 'number' ? record.version : BASELINE_VERSION,
    ids: idsRaw.filter((entry): entry is string => typeof entry === 'string'),
  };
}
