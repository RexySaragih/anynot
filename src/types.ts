export type AnyKind =
  | 'annotation'
  | 'parameter'
  | 'return'
  | 'assertion'
  | 'generic'
  | 'rest'
  | 'implicit'
  | 'jsdoc';

export type Confidence = 'high' | 'medium' | 'low';

export interface Suggestion {
  typeText: string;
  confidence: Confidence;
  why: string;
  evidence?: string[];
  /** False when the candidate fails assignability at collected use sites. */
  assignable?: boolean;
}

export interface Finding {
  id: string;
  file: string;
  line: number;
  column: number;
  kind: AnyKind;
  snippet: string;
  /** 0-based index of `any` within the trimmed snippet line. */
  snippetAnyOffset?: number;
  /** Declaration / binding name when available (e.g. payload). */
  symbolName?: string;
  nodeStart: number;
  nodeEnd: number;
  /** Best (concrete) suggestion. */
  suggestion?: Suggestion;
  /** Conservative fallback when best is speculative. */
  safeSuggestion?: Suggestion;
  implicit?: boolean;
  /** True when --fix would rewrite this finding. */
  fixable?: boolean;
  /** Optional root-cause hint, e.g. re-export of untyped dependency. */
  rootCause?: string;
}

export interface TypeCoverage {
  /** Identifiers / type positions considered. */
  total: number;
  /** Positions that are not `any`. */
  typed: number;
  /** Positions typed as `any`. */
  anyCount: number;
  /** 0–100 percentage of non-any positions. */
  percentage: number;
}

export interface AnalyzeOptions {
  tsconfig?: string;
  cwd?: string;
  include?: string[];
  exclude?: string[];
  includeImplicit?: boolean;
  skipInference?: boolean;
  /** Optional status messages during analysis (CLI uses stderr progress). */
  onProgress?: (message: string) => void;
}

export interface AnalyzeResult {
  findings: Finding[];
  programRoot: string;
  tsconfigPath: string;
  coverage: TypeCoverage;
}

export interface FixResult {
  fixed: number;
  skipped: number;
  files: string[];
}

export interface DryRunReplacement {
  file: string;
  line: number;
  column: number;
  before: string;
  after: string;
}

export interface DryRunResult {
  fixed: number;
  skipped: number;
  files: string[];
  replacements: DryRunReplacement[];
  /** Full-file before/after for each changed file. */
  fileDiffs: Array<{ file: string; before: string; after: string }>;
}

export const UNKNOWN_FALLBACK = 'unknown';
export const HIGH_CONFIDENCE: Confidence = 'high';
export const MEDIUM_CONFIDENCE: Confidence = 'medium';
export const LOW_CONFIDENCE: Confidence = 'low';

export const STRING_METHODS = [
  'split',
  'slice',
  'toLowerCase',
  'toUpperCase',
  'includes',
  'startsWith',
  'endsWith',
  'trim',
  'replace',
  'substring',
  'charAt',
  'indexOf',
] as const;

export const NUMBER_METHODS = ['toFixed', 'toExponential', 'toPrecision'] as const;

export const WIDE_UNION_MEMBER_LIMIT = 4;
