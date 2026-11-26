import type ts from 'typescript';

const IGNORE_DIRECTIVE = 'anynot-ignore';
const NEXT_LINE_DIRECTIVE = 'anynot-ignore-next-line';
const FINDING_ID_PATTERN = /\b([a-f0-9]{12})\b/gi;

const ignoredIdsCache = new WeakMap<ts.SourceFile, Set<string>>();

export function isIgnoredAt(sourceFile: ts.SourceFile, node: ts.Node, findingId?: string): boolean {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const text = sourceFile.getFullText();
  const lineStarts = sourceFile.getLineStarts();

  if (matchesIgnore(getLineText(text, lineStarts, line), 'line', findingId)) {
    return true;
  }

  if (line > 0 && matchesIgnore(getLineText(text, lineStarts, line - 1), 'next-line', findingId)) {
    return true;
  }

  if (findingId && collectIgnoredIds(sourceFile).has(findingId.toLowerCase())) {
    return true;
  }

  return false;
}

/**
 * Collect finding IDs listed in `// anynot-ignore <id>` comments anywhere in the file.
 */
export function collectIgnoredIds(sourceFile: ts.SourceFile): Set<string> {
  const cached = ignoredIdsCache.get(sourceFile);
  if (cached) {
    return cached;
  }

  const ids = new Set<string>();
  const text = sourceFile.getFullText();
  const lineStarts = sourceFile.getLineStarts();

  for (let line = 0; line < lineStarts.length; line += 1) {
    const parsed = parseIgnoreComment(getLineText(text, lineStarts, line));
    if (!parsed || parsed.kind !== 'ignore' || parsed.ids.length === 0) {
      continue;
    }
    for (const id of parsed.ids) {
      ids.add(id);
    }
  }

  ignoredIdsCache.set(sourceFile, ids);
  return ids;
}

function matchesIgnore(lineText: string, mode: 'line' | 'next-line', findingId?: string): boolean {
  const parsed = parseIgnoreComment(lineText);
  if (!parsed) {
    return false;
  }

  if (mode === 'line' && parsed.kind !== 'ignore') {
    return false;
  }
  if (mode === 'next-line' && parsed.kind !== 'next-line') {
    return false;
  }

  if (parsed.ids.length === 0) {
    return true;
  }

  return findingId !== undefined && parsed.ids.includes(findingId.toLowerCase());
}

function parseIgnoreComment(
  lineText: string,
): { kind: 'ignore' | 'next-line'; ids: string[] } | null {
  const trimmed = lineText.replace(/\r?\n$/, '');
  const commentMatch = trimmed.match(/\/\/\s*(.+)$/);
  if (!commentMatch) {
    return null;
  }

  const body = commentMatch[1]!.trim();
  const lower = body.toLowerCase();

  if (lower.startsWith(NEXT_LINE_DIRECTIVE) || lower.startsWith(`${IGNORE_DIRECTIVE}-next-line`)) {
    return {
      kind: 'next-line',
      ids: extractIds(body),
    };
  }

  if (lower.startsWith(IGNORE_DIRECTIVE)) {
    const after = body.slice(IGNORE_DIRECTIVE.length);
    if (after.length > 0 && !/^\s/.test(after) && !after.startsWith('-')) {
      return null;
    }
    return {
      kind: 'ignore',
      ids: extractIds(body),
    };
  }

  return null;
}

function extractIds(commentBody: string): string[] {
  const ids: string[] = [];
  FINDING_ID_PATTERN.lastIndex = 0;
  let match = FINDING_ID_PATTERN.exec(commentBody);
  while (match) {
    ids.push(match[1]!.toLowerCase());
    match = FINDING_ID_PATTERN.exec(commentBody);
  }
  return ids;
}

function getLineText(text: string, lineStarts: readonly number[], line: number): string {
  const start = lineStarts[line] ?? 0;
  const end = line + 1 < lineStarts.length ? lineStarts[line + 1]! : text.length;
  return text.slice(start, end);
}
