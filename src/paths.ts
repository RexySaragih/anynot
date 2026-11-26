import path from 'node:path';

/**
 * Normalize an absolute path to a forward-slash relative path under rootDir.
 */
export function toRelative(fileName: string, rootDir: string): string {
  return path.relative(rootDir, fileName).split(path.sep).join('/');
}

/**
 * Resolve target under root and reject paths that escape the confine root.
 */
export function resolveUnderRoot(root: string, target: string): string {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, target);
  const relative = path.relative(absoluteRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path "${target}" is outside confine root "${root}"`);
  }
  return absolute;
}
