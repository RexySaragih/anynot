import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { resolveUnderRoot } from './paths.js';
import {
  type DryRunReplacement,
  type DryRunResult,
  type Finding,
  type FixResult,
  HIGH_CONFIDENCE,
} from './types.js';

/**
 * Apply high-confidence, assignable replacements only.
 * Rewrites the whole type node when any is nested (e.g. Promise<any> → Promise<User>).
 * Writes are confined to confineRoot (defaults to rootDir).
 */
export function applyFixes(
  findings: Finding[],
  rootDir: string,
  confineRoot: string = rootDir,
): FixResult {
  const preview = previewFixes(findings, rootDir, confineRoot);
  for (const diff of preview.fileDiffs) {
    const absolutePath = resolveUnderRoot(confineRoot, path.resolve(rootDir, diff.file));
    fs.writeFileSync(absolutePath, diff.after, 'utf8');
  }
  return {
    fixed: preview.fixed,
    skipped: preview.skipped,
    files: preview.files,
  };
}

/**
 * Compute fix replacements without writing files.
 * Skips findings whose resolved path escapes confineRoot.
 */
export function previewFixes(
  findings: Finding[],
  rootDir: string,
  confineRoot: string = rootDir,
): DryRunResult {
  const fixable = findings.filter(isFixable);
  const byFile = groupByFile(fixable);

  let fixed = 0;
  let skipped = findings.length - fixable.length;
  const changedFiles: string[] = [];
  const replacements: DryRunReplacement[] = [];
  const fileDiffs: Array<{ file: string; before: string; after: string }> = [];

  for (const [relativeFile, fileFindings] of byFile) {
    let absolutePath: string;
    try {
      absolutePath = resolveUnderRoot(confineRoot, path.resolve(rootDir, relativeFile));
    } catch {
      skipped += fileFindings.length;
      continue;
    }
    if (!fs.existsSync(absolutePath)) {
      skipped += fileFindings.length;
      continue;
    }

    const original = fs.readFileSync(absolutePath, 'utf8');
    const scriptKind = absolutePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
      absolutePath,
      original,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );

    const fileReplacements = buildReplacements(sourceFile, fileFindings, original);
    if (fileReplacements.length === 0) {
      skipped += fileFindings.length;
      continue;
    }

    const next = applyReplacements(original, fileReplacements);
    if (next === original) {
      skipped += fileFindings.length;
      continue;
    }

    for (const replacement of fileReplacements) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(replacement.start);
      replacements.push({
        file: relativeFile,
        line: line + 1,
        column: character + 1,
        before: original.slice(replacement.start, replacement.end),
        after: replacement.text,
      });
    }

    fixed += fileReplacements.length;
    skipped += fileFindings.length - fileReplacements.length;
    changedFiles.push(relativeFile);
    fileDiffs.push({ file: relativeFile, before: original, after: next });
  }

  return {
    fixed,
    skipped,
    files: changedFiles,
    replacements,
    fileDiffs,
  };
}

export function formatDryRun(preview: DryRunResult): string {
  if (preview.replacements.length === 0) {
    return 'Dry run: no high-confidence assignable fixes.\n';
  }

  const lines: string[] = [`Dry run: would fix ${preview.fixed}, skip ${preview.skipped}`];

  for (const diff of preview.fileDiffs) {
    lines.push(`--- ${diff.file}`);
    lines.push(`+++ ${diff.file}`);
    lines.push(...unifiedHunks(diff.before, diff.after));
  }

  for (const replacement of preview.replacements) {
    lines.push(`${replacement.file}:${replacement.line}:${replacement.column}`);
    lines.push(`- ${replacement.before}`);
    lines.push(`+ ${replacement.after}`);
  }

  return `${lines.join('\n')}\n`;
}

function unifiedHunks(before: string, after: string): string[] {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const hunks: string[] = [];
  const max = Math.max(beforeLines.length, afterLines.length);

  let i = 0;
  while (i < max) {
    if (beforeLines[i] === afterLines[i]) {
      i += 1;
      continue;
    }

    const start = i;
    while (i < max && beforeLines[i] !== afterLines[i]) {
      i += 1;
    }

    hunks.push(`@@ -${start + 1},${i - start} +${start + 1},${i - start} @@`);
    for (let j = start; j < i; j += 1) {
      if (j < beforeLines.length) {
        hunks.push(`-${beforeLines[j]}`);
      }
      if (j < afterLines.length) {
        hunks.push(`+${afterLines[j]}`);
      }
    }
  }

  return hunks;
}

export function isFixable(finding: Finding): boolean {
  if (finding.fixable === false) {
    return false;
  }
  if (finding.fixable === true) {
    return isSafeSuggestionText(finding.suggestion);
  }
  if (!finding.suggestion) {
    return false;
  }
  if (finding.suggestion.confidence !== HIGH_CONFIDENCE) {
    return false;
  }
  if (finding.suggestion.assignable === false) {
    return false;
  }
  if (finding.implicit) {
    return false;
  }
  return isSafeSuggestionText(finding.suggestion);
}

function isSafeSuggestionText(suggestion: Finding['suggestion']): boolean {
  if (!suggestion) {
    return false;
  }
  const typeText = suggestion.typeText.trim();
  if (!typeText || typeText === 'any' || /\bany\b/.test(typeText)) {
    return false;
  }
  return true;
}

function groupByFile(findings: Finding[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = map.get(finding.file) ?? [];
    list.push(finding);
    map.set(finding.file, list);
  }
  return map;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

function buildReplacements(
  sourceFile: ts.SourceFile,
  findings: Finding[],
  sourceText: string,
): Replacement[] {
  const replacements: Replacement[] = [];
  const ordered = [...findings].sort((a, b) => b.nodeStart - a.nodeStart);

  for (const finding of ordered) {
    const suggestion = finding.suggestion!.typeText;
    const range = resolveReplacementRange(sourceFile, finding, suggestion);
    if (!range) {
      continue;
    }

    if (range.start < 0 || range.end > sourceText.length || range.start >= range.end) {
      continue;
    }

    replacements.push({
      start: range.start,
      end: range.end,
      text: suggestion,
    });
  }

  return replacements;
}

/**
 * Prefer rewriting the whole type node when suggestion replaces a container
 * (Promise<any> → Promise<User>) or when any is a lone annotation.
 */
function resolveReplacementRange(
  sourceFile: ts.SourceFile,
  finding: Finding,
  suggestion: string,
): { start: number; end: number } | undefined {
  const anyNode = findAnyKeyword(sourceFile, finding.nodeStart, finding.nodeEnd);
  if (!anyNode) {
    return undefined;
  }

  const parent = anyNode.parent;

  if (ts.isTypeReferenceNode(parent) && parent.typeArguments?.length) {
    const onlyAny = parent.typeArguments.length === 1 && parent.typeArguments[0] === anyNode;
    const suggestionLooksLikeTypeRef = /^[A-Za-z_][A-Za-z0-9_]*\s*</.test(suggestion.trim());
    if (onlyAny && suggestionLooksLikeTypeRef) {
      return {
        start: parent.getStart(sourceFile),
        end: parent.getEnd(),
      };
    }
  }

  if (ts.isArrayTypeNode(parent) && parent.elementType === anyNode) {
    if (suggestion.includes('[]') || suggestion.startsWith('Array<')) {
      return {
        start: parent.getStart(sourceFile),
        end: parent.getEnd(),
      };
    }
  }

  // Default: replace the AnyKeyword token only
  const current = sourceFile.getFullText().slice(finding.nodeStart, finding.nodeEnd);
  if (current !== 'any') {
    return undefined;
  }

  return {
    start: finding.nodeStart,
    end: finding.nodeEnd,
  };
}

function findAnyKeyword(
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
): ts.Node | undefined {
  let match: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (
      node.kind === ts.SyntaxKind.AnyKeyword &&
      node.getStart(sourceFile) === start &&
      node.getEnd() === end
    ) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return match;
}

function applyReplacements(source: string, replacements: Replacement[]): string {
  let result = source;
  for (const replacement of replacements) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return result;
}
