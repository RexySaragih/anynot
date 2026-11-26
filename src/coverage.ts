import ts from 'typescript';
import type { TypeCoverage } from './types.js';

const PERCENT_SCALE = 100;
const EMPTY_COVERAGE: TypeCoverage = {
  total: 0,
  typed: 0,
  anyCount: 0,
  percentage: PERCENT_SCALE,
};

/**
 * Measure type coverage as the share of checked identifiers whose type is not `any`.
 * Same idea as the `type-coverage` package: walk identifiers and ask the checker.
 */
export function computeTypeCoverage(
  program: ts.Program,
  sourceFiles: readonly ts.SourceFile[],
): TypeCoverage {
  const checker = program.getTypeChecker();
  let total = 0;
  let anyCount = 0;

  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && shouldCountIdentifier(node)) {
        total += 1;
        const type = checker.getTypeAtLocation(node);
        if (isAnyType(type)) {
          anyCount += 1;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return finalizeCoverage(total, anyCount);
}

export function mergeCoverage(...parts: TypeCoverage[]): TypeCoverage {
  if (parts.length === 0) {
    return { ...EMPTY_COVERAGE };
  }

  let total = 0;
  let anyCount = 0;
  for (const part of parts) {
    total += part.total;
    anyCount += part.anyCount;
  }
  return finalizeCoverage(total, anyCount);
}

export function formatCoveragePercent(coverage: TypeCoverage): string {
  return `${formatPercentage(coverage.percentage)}%`;
}

function finalizeCoverage(total: number, anyCount: number): TypeCoverage {
  if (total === 0) {
    return { ...EMPTY_COVERAGE };
  }
  const typed = total - anyCount;
  const percentage = (typed / total) * PERCENT_SCALE;
  return { total, typed, anyCount, percentage };
}

function formatPercentage(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function isAnyType(type: ts.Type): boolean {
  if (type.flags & ts.TypeFlags.Any) {
    return true;
  }
  if (type.isUnion()) {
    return type.types.some((member) => (member.flags & ts.TypeFlags.Any) !== 0);
  }
  return false;
}

function shouldCountIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }

  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)) {
    return false;
  }
  if (ts.isExportSpecifier(parent) || ts.isNamespaceExport(parent)) {
    return false;
  }
  if (ts.isTypeParameterDeclaration(parent) && parent.name === node) {
    return false;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return false;
  }
  if (ts.isJsxAttribute(parent) && parent.name === node) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) {
    return false;
  }
  if (ts.isMetaProperty(parent)) {
    return false;
  }
  if (ts.isTypeReferenceNode(parent)) {
    return (
      parent.typeName === node ||
      (ts.isQualifiedName(parent.typeName) && parent.typeName.right === node)
    );
  }
  if (ts.isExpressionWithTypeArguments(parent)) {
    return (
      parent.expression === node ||
      (ts.isPropertyAccessExpression(parent.expression) && parent.expression.name === node)
    );
  }

  return true;
}
