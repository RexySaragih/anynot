import path from 'node:path';

/**
 * Minimal glob matcher (supports *, **, ?, and path separators).
 * Avoids minimatch ReDoS-prone dependency for simple include/exclude.
 */
export function matchGlob(filePath: string, pattern: string, cwd: string): boolean {
  const relative = toPosix(path.relative(cwd, path.resolve(cwd, filePath)));
  const normalizedPattern = toPosix(pattern);
  const regex = globToRegExp(normalizedPattern);
  return regex.test(relative) || regex.test(toPosix(filePath));
}

export function matchesAnyGlob(
  filePath: string,
  patterns: string[] | undefined,
  cwd: string,
): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  return patterns.some((pattern) => matchGlob(filePath, pattern, cwd));
}

export function isIncluded(
  filePath: string,
  cwd: string,
  include?: string[],
  exclude?: string[],
): boolean {
  if (matchesAnyGlob(filePath, exclude, cwd)) {
    return false;
  }
  if (!include || include.length === 0) {
    return true;
  }
  return matchesAnyGlob(filePath, include, cwd);
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];

    if (char === '*' && pattern[index + 1] === '*') {
      const afterStars = pattern[index + 2];
      if (afterStars === '/') {
        source += '(?:.*/)?';
        index += 3;
        continue;
      }
      source += '.*';
      index += 2;
      continue;
    }

    if (char === '*') {
      source += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    if ('+.^$()[]{}|'.includes(char)) {
      source += `\\${char}`;
      index += 1;
      continue;
    }

    source += char;
    index += 1;
  }

  source += '$';
  return new RegExp(source);
}
