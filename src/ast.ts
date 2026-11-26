import ts from 'typescript';

/**
 * Find the AST node whose exact span matches [start, end).
 */
export function findNodeAt(
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
): ts.Node | undefined {
  let match: ts.Node | undefined;

  const visit = (node: ts.Node): void => {
    if (node.getStart(sourceFile) === start && node.getEnd() === end) {
      match = node;
      return;
    }
    if (node.getStart(sourceFile) <= start && node.getEnd() >= end) {
      ts.forEachChild(node, visit);
    }
  };

  visit(sourceFile);
  return match;
}
