import fs from 'node:fs';
import path from 'node:path';
import type { AnyKind } from './types.js';

const CONFIG_BASENAMES = [
  'anynot.json',
  'anynot.jsonc',
  '.anynot.json',
  '.anynot.jsonc',
] as const;

const KNOWN_KEYS = new Set([
  '$schema',
  'include',
  'ignore',
  'exclude',
  'tsconfig',
  'includeImplicit',
  'baseline',
  'ignoreKinds',
  'reporter',
  'out',
  'json',
]);

const ANY_KINDS = new Set<AnyKind>([
  'annotation',
  'parameter',
  'return',
  'assertion',
  'generic',
  'rest',
  'implicit',
  'jsdoc',
]);

export interface AnynotConfig {
  include?: string[];
  exclude?: string[];
  tsconfig?: string;
  includeImplicit?: boolean;
  baseline?: string;
  ignoreKinds?: AnyKind[];
  reporter?: string;
  out?: string;
  json?: boolean;
}

export interface LoadConfigResult {
  config: AnynotConfig;
  path: string | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(
  cwd: string,
  explicitPath?: string,
  warn: (message: string) => void = (message) => {
    process.stderr.write(`anynot: ${message}\n`);
  },
): LoadConfigResult {
  if (explicitPath) {
    const resolved = path.resolve(cwd, explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new ConfigError(`config not found: ${explicitPath}`);
    }
    return {
      config: parseConfigFile(resolved, warn),
      path: resolved,
    };
  }

  for (const basename of CONFIG_BASENAMES) {
    const candidate = path.join(cwd, basename);
    if (!fs.existsSync(candidate)) {
      continue;
    }
    return {
      config: parseConfigFile(candidate, warn),
      path: candidate,
    };
  }

  const packageJsonPath = path.join(cwd, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const fromPackage = readPackageAnynot(packageJsonPath, warn);
    if (fromPackage) {
      return { config: fromPackage, path: packageJsonPath };
    }
  }

  return { config: {}, path: undefined };
}

function parseConfigFile(filePath: string, warn: (message: string) => void): AnynotConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`cannot read config ${filePath}: ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(raw));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`invalid config ${filePath}: ${detail}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`invalid config ${filePath}: expected a JSON object`);
  }

  return normalizeConfig(parsed as Record<string, unknown>, filePath, warn);
}

function readPackageAnynot(
  packageJsonPath: string,
  warn: (message: string) => void,
): AnynotConfig | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`invalid package.json ${packageJsonPath}: ${detail}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }

  const anynot = (parsed as Record<string, unknown>).anynot;
  if (anynot === undefined) {
    return undefined;
  }
  if (anynot === null || typeof anynot !== 'object' || Array.isArray(anynot)) {
    throw new ConfigError(
      `invalid config ${packageJsonPath}#anynot: expected a JSON object`,
    );
  }

  return normalizeConfig(anynot as Record<string, unknown>, `${packageJsonPath}#anynot`, warn);
}

function normalizeConfig(
  raw: Record<string, unknown>,
  sourceLabel: string,
  warn: (message: string) => void,
): AnynotConfig {
  const unknownKeys = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key));
  for (const key of unknownKeys) {
    warn(`unknown config key "${key}" in ${sourceLabel}`);
  }

  const include = optionalStringArray(raw.include, 'include', sourceLabel);
  const ignore = optionalStringArray(raw.ignore, 'ignore', sourceLabel);
  const excludeAlias = optionalStringArray(raw.exclude, 'exclude', sourceLabel);
  const exclude = uniqueStrings([...(ignore ?? []), ...(excludeAlias ?? [])]);

  const ignoreKinds = optionalIgnoreKinds(raw.ignoreKinds, sourceLabel);

  return {
    include: include && include.length > 0 ? include : undefined,
    exclude: exclude.length > 0 ? exclude : undefined,
    tsconfig: optionalString(raw.tsconfig, 'tsconfig', sourceLabel),
    includeImplicit: optionalBoolean(raw.includeImplicit, 'includeImplicit', sourceLabel),
    baseline: optionalString(raw.baseline, 'baseline', sourceLabel),
    ignoreKinds: ignoreKinds && ignoreKinds.length > 0 ? ignoreKinds : undefined,
    reporter: optionalString(raw.reporter, 'reporter', sourceLabel),
    out: optionalString(raw.out, 'out', sourceLabel),
    json: optionalBoolean(raw.json, 'json', sourceLabel),
  };
}

function optionalString(
  value: unknown,
  field: string,
  sourceLabel: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`invalid config ${sourceLabel}: "${field}" must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(
  value: unknown,
  field: string,
  sourceLabel: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new ConfigError(`invalid config ${sourceLabel}: "${field}" must be a boolean`);
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  field: string,
  sourceLabel: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError(
      `invalid config ${sourceLabel}: "${field}" must be an array of strings`,
    );
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function optionalIgnoreKinds(value: unknown, sourceLabel: string): AnyKind[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError(
      `invalid config ${sourceLabel}: "ignoreKinds" must be an array of strings`,
    );
  }

  const kinds: AnyKind[] = [];
  for (const entry of value) {
    const kind = entry.trim() as AnyKind;
    if (!ANY_KINDS.has(kind)) {
      throw new ConfigError(
        `invalid config ${sourceLabel}: unknown ignoreKinds entry "${entry}"`,
      );
    }
    if (!kinds.includes(kind)) {
      kinds.push(kind);
    }
  }
  return kinds;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

/** Strip line and block comments outside of strings (JSONC). */
export function stripJsonc(source: string): string {
  let result = '';
  let index = 0;
  let inString = false;
  let stringQuote = '';

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];

    if (inString) {
      result += char;
      if (char === '\\' && index + 1 < source.length) {
        result += source[index + 1]!;
        index += 2;
        continue;
      }
      if (char === stringQuote) {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      result += char;
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index + 1 < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 2;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}
