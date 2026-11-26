import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { findNodeAt } from './ast.js';
import { isIgnoredAt } from './ignore.js';
import { toRelative } from './paths.js';
import type { AnyKind, Finding } from './types.js';

const SNIPPET_MAX_LENGTH = 80;

export function findExplicitAny(sourceFile: ts.SourceFile, rootDir: string): Finding[] {
  const findings: Finding[] = [];

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const finding = createFinding(sourceFile, node, rootDir);
      if (!isIgnoredAt(sourceFile, node, finding.id)) {
        findings.push(finding);
      }
    }
    findings.push(...findJsDocAnyOnNode(sourceFile, node, rootDir));
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

/**
 * Detect JSDoc `@type {any}`, `@param {any}`, `@returns {any}`, etc.
 * forEachChild does not walk JSDoc, so this is an explicit pass.
 */
function findJsDocAnyOnNode(sourceFile: ts.SourceFile, node: ts.Node, rootDir: string): Finding[] {
  const jsDocs = getJsDocs(node);
  if (jsDocs.length === 0) {
    return [];
  }

  const findings: Finding[] = [];
  for (const doc of jsDocs) {
    if (!doc.tags) {
      continue;
    }
    for (const tag of doc.tags) {
      const typeExpression = getJsDocTypeExpression(tag);
      if (!typeExpression) {
        continue;
      }
      collectJsDocAnyKeywords(typeExpression, (anyNode) => {
        const finding = createJsDocFinding(sourceFile, anyNode, rootDir, tag);
        if (!isIgnoredAt(sourceFile, anyNode, finding.id)) {
          findings.push(finding);
        }
      });
    }
  }
  return findings;
}

function getJsDocs(node: ts.Node): readonly ts.JSDoc[] {
  const withDocs = node as ts.Node & { jsDoc?: readonly ts.JSDoc[] };
  return withDocs.jsDoc ?? [];
}

function getJsDocTypeExpression(tag: ts.JSDocTag): ts.JSDocTypeExpression | undefined {
  if (ts.isJSDocTypeTag(tag) || ts.isJSDocParameterTag(tag) || ts.isJSDocReturnTag(tag)) {
    return tag.typeExpression;
  }
  if (ts.isJSDocTemplateTag(tag) && tag.constraint) {
    return undefined;
  }
  const maybe = tag as ts.JSDocTag & { typeExpression?: ts.JSDocTypeExpression };
  return maybe.typeExpression;
}

function collectJsDocAnyKeywords(node: ts.Node, onAny: (anyNode: ts.Node) => void): void {
  if (node.kind === ts.SyntaxKind.AnyKeyword) {
    onAny(node);
  }
  ts.forEachChild(node, (child) => collectJsDocAnyKeywords(child, onAny));
}

function createJsDocFinding(
  sourceFile: ts.SourceFile,
  anyNode: ts.Node,
  rootDir: string,
  tag: ts.JSDocTag,
): Finding {
  const start = anyNode.getStart(sourceFile);
  const end = anyNode.getEnd();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
  const relativeFile = toRelative(sourceFile.fileName, rootDir);
  const kind: AnyKind = 'jsdoc';
  const tagName = tag.tagName.getText(sourceFile);
  const snippetInfo = extractSnippetInfo(sourceFile, start);
  const snippet = snippetInfo.text.includes(`@${tagName}`) ? snippetInfo.text : `@${tagName} {any}`;
  const symbolName = getJsDocSymbolName(tag);

  return {
    id: createFindingId(relativeFile, line + 1, character + 1, kind),
    file: relativeFile,
    line: line + 1,
    column: character + 1,
    kind,
    snippet,
    snippetAnyOffset:
      snippet === snippetInfo.text
        ? snippetInfo.anyOffset
        : Math.max(0, snippet.toLowerCase().indexOf('any')),
    symbolName,
    nodeStart: start,
    nodeEnd: end,
  };
}

function createFinding(sourceFile: ts.SourceFile, anyNode: ts.Node, rootDir: string): Finding {
  const start = anyNode.getStart(sourceFile);
  const end = anyNode.getEnd();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
  const relativeFile = toRelative(sourceFile.fileName, rootDir);
  const kind = classifyAnyKind(anyNode);
  const snippetInfo = extractSnippetInfo(sourceFile, start);

  return {
    id: createFindingId(relativeFile, line + 1, character + 1, kind),
    file: relativeFile,
    line: line + 1,
    column: character + 1,
    kind,
    snippet: snippetInfo.text,
    snippetAnyOffset: snippetInfo.anyOffset,
    symbolName: extractSymbolName(anyNode, kind),
    nodeStart: start,
    nodeEnd: end,
  };
}

function getJsDocSymbolName(tag: ts.JSDocTag): string | undefined {
  if (ts.isJSDocParameterTag(tag) && tag.name) {
    return tag.name.getText();
  }
  return tag.tagName.getText();
}

function extractSymbolName(anyNode: ts.Node, kind: AnyKind): string | undefined {
  const parent = anyNode.parent;
  if (!parent) {
    return undefined;
  }

  if (ts.isParameter(parent) && parent.type === anyNode) {
    return getBindingName(parent.name);
  }

  if (ts.isParameterPropertyDeclaration(parent, parent.parent) && parent.type === anyNode) {
    return getBindingName(parent.name);
  }

  if (ts.isFunctionLike(parent) && parent.type === anyNode) {
    return parent.name ? parent.name.getText() : undefined;
  }

  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isParameter(parent)) &&
    'type' in parent &&
    parent.type === anyNode
  ) {
    return 'name' in parent && parent.name
      ? getBindingName(parent.name as ts.BindingName)
      : undefined;
  }

  if (
    ts.isArrayTypeNode(parent) &&
    parent.elementType === anyNode &&
    ts.isParameter(parent.parent)
  ) {
    return getBindingName(parent.parent.name);
  }

  return findEnclosingSymbolName(anyNode, kind);
}

function findEnclosingSymbolName(anyNode: ts.Node, _kind: AnyKind): string | undefined {
  let current: ts.Node | undefined = anyNode.parent;
  while (current) {
    if (ts.isParameter(current)) {
      return getBindingName(current.name);
    }
    if (ts.isVariableDeclaration(current)) {
      return getBindingName(current.name);
    }
    if (ts.isPropertyDeclaration(current) || ts.isPropertySignature(current)) {
      return current.name.getText();
    }
    if (ts.isFunctionLike(current) && current.name) {
      return current.name.getText();
    }
    if (ts.isTypeAliasDeclaration(current) || ts.isInterfaceDeclaration(current)) {
      return current.name.text;
    }
    if (ts.isSourceFile(current)) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function getBindingName(name: ts.BindingName): string {
  if (ts.isIdentifier(name)) {
    return name.text;
  }
  return name.getText();
}

export function classifyAnyKind(anyNode: ts.Node): AnyKind {
  const parent = anyNode.parent;
  if (!parent) {
    return 'annotation';
  }

  if (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) {
    return 'assertion';
  }

  if (ts.isArrayTypeNode(parent) && parent.elementType === anyNode) {
    if (isRestParameterArray(parent)) {
      return 'rest';
    }
    return 'generic';
  }

  if (ts.isTypeReferenceNode(parent)) {
    return 'generic';
  }

  if (ts.isTypeParameterDeclaration(parent) || isGenericTypeArgument(anyNode)) {
    return 'generic';
  }

  if (ts.isFunctionLike(parent) && parent.type === anyNode) {
    return 'return';
  }

  if (ts.isParameter(parent) && parent.type === anyNode) {
    if (parent.dotDotDotToken) {
      return 'rest';
    }
    return 'parameter';
  }

  if (ts.isParameterPropertyDeclaration(parent, parent.parent) && parent.type === anyNode) {
    return 'parameter';
  }

  if (
    ts.isParameter(parent.parent) &&
    parent.parent.dotDotDotToken &&
    isRestAnyArray(parent.parent)
  ) {
    return 'rest';
  }

  return 'annotation';
}

function isGenericTypeArgument(anyNode: ts.Node): boolean {
  let current: ts.Node | undefined = anyNode.parent;
  while (current) {
    if (ts.isTypeReferenceNode(current) || ts.isExpressionWithTypeArguments(current)) {
      return true;
    }
    if (ts.isArrayTypeNode(current)) {
      return true;
    }
    if (
      ts.isParameter(current) ||
      ts.isVariableDeclaration(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isPropertySignature(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isFunctionLike(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function isRestParameterArray(arrayType: ts.ArrayTypeNode): boolean {
  const parent = arrayType.parent;
  return ts.isParameter(parent) && !!parent.dotDotDotToken && parent.type === arrayType;
}

function isRestAnyArray(parameter: ts.ParameterDeclaration): boolean {
  if (!parameter.type || !ts.isArrayTypeNode(parameter.type)) {
    return false;
  }
  return parameter.type.elementType.kind === ts.SyntaxKind.AnyKeyword;
}

function extractSnippetInfo(
  sourceFile: ts.SourceFile,
  position: number,
): { text: string; anyOffset: number } {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  const lineStarts = sourceFile.getLineStarts();
  const start = lineStarts[line] ?? 0;
  const end =
    line + 1 < lineStarts.length ? lineStarts[line + 1]! : sourceFile.getFullText().length;
  const rawLine = sourceFile
    .getFullText()
    .slice(start, end)
    .replace(/\r?\n$/, '');
  const leadingWhitespace = rawLine.length - rawLine.trimStart().length;
  const trimmed = rawLine.trim();
  const anyOffset = Math.max(0, character - leadingWhitespace);

  if (trimmed.length <= SNIPPET_MAX_LENGTH) {
    return { text: trimmed, anyOffset };
  }

  const visibleLimit = SNIPPET_MAX_LENGTH - 1;
  const clippedOffset = Math.min(anyOffset, visibleLimit - 1);
  return {
    text: `${trimmed.slice(0, visibleLimit)}…`,
    anyOffset: Math.max(0, clippedOffset),
  };
}

function createFindingId(file: string, line: number, column: number, kind: AnyKind): string {
  const payload = `${file}:${line}:${column}:${kind}`;
  return createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

function extractImplicitSymbolName(
  sourceFile: ts.SourceFile,
  position: number,
): string | undefined {
  const token = (
    ts as typeof ts & {
      getTokenAtPosition?: (sourceFile: ts.SourceFile, position: number) => ts.Node;
    }
  ).getTokenAtPosition?.(sourceFile, position);

  if (token && ts.isIdentifier(token)) {
    return token.text;
  }

  let match: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (match) {
      return;
    }
    if (
      ts.isIdentifier(node) &&
      node.getStart(sourceFile) <= position &&
      node.getEnd() >= position
    ) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return match?.text;
}

/**
 * When a local `any` is an exported alias that mirrors an import from an
 * untyped (or any-typed) dependency, attach a rootCause hint.
 */
export function enrichImportedAnyRootCause(
  findings: Finding[],
  program: ts.Program,
  checker: ts.TypeChecker,
  sourceFileByPath: Map<string, ts.SourceFile>,
  rootDir: string,
): Finding[] {
  return findings.map((finding) => {
    if (finding.rootCause || finding.kind === 'implicit' || finding.kind === 'jsdoc') {
      return finding;
    }

    const sourceFile = resolveSourceFile(finding, sourceFileByPath, rootDir);
    if (!sourceFile) {
      return finding;
    }

    const node = findNodeAt(sourceFile, finding.nodeStart, finding.nodeEnd);
    if (!node) {
      return finding;
    }

    const rootCause = detectImportedAnyRootCause(node, sourceFile, checker, program);
    if (!rootCause) {
      return finding;
    }

    return { ...finding, rootCause };
  });
}

function detectImportedAnyRootCause(
  anyNode: ts.Node,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  program: ts.Program,
): string | undefined {
  const alias = findEnclosingTypeAlias(anyNode);
  if (!alias || !alias.name) {
    return undefined;
  }

  const exported = isNodeExported(alias);
  if (!exported) {
    return undefined;
  }

  const aliasName = alias.name.text;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) {
      continue;
    }
    const packageName = packageNameFromSpecifier(moduleSpecifier.text);
    if (!packageName) {
      continue;
    }

    if (!importNamesMatch(statement.importClause, aliasName)) {
      continue;
    }

    const resolved = resolveModuleFile(program, sourceFile.fileName, moduleSpecifier.text);
    if (resolved && isProjectSourceFile(resolved, program)) {
      continue;
    }

    const importSymbol = findImportedSymbol(statement.importClause, aliasName, checker);
    if (importSymbol) {
      const importType = checker.getTypeOfSymbolAtLocation(importSymbol, statement);
      if (isAnyLikeType(importType, checker)) {
        return `imported any from package ${packageName}`;
      }
    }

    // Untyped / JS-only dependency (no declarations) is a common any root cause
    if (!resolved || isUntypedDependencyFile(resolved)) {
      return `imported any from package ${packageName}`;
    }
  }

  return undefined;
}

function findEnclosingTypeAlias(node: ts.Node): ts.TypeAliasDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isTypeAliasDeclaration(current)) {
      return current;
    }
    if (ts.isSourceFile(current)) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function isNodeExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    return true;
  }
  return !!node.parent && ts.isExportAssignment(node.parent);
}

function importNamesMatch(clause: ts.ImportClause, name: string): boolean {
  if (clause.name?.text === name) {
    return true;
  }
  const bindings = clause.namedBindings;
  if (!bindings) {
    return false;
  }
  if (ts.isNamespaceImport(bindings)) {
    return bindings.name.text === name;
  }
  return bindings.elements.some(
    (element) => (element.propertyName ?? element.name).text === name || element.name.text === name,
  );
}

function findImportedSymbol(
  clause: ts.ImportClause,
  name: string,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (clause.name?.text === name) {
    return checker.getSymbolAtLocation(clause.name);
  }
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) {
    return bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name
      ? checker.getSymbolAtLocation(bindings.name)
      : undefined;
  }
  for (const element of bindings.elements) {
    if (element.name.text === name || element.propertyName?.text === name) {
      return checker.getSymbolAtLocation(element.name);
    }
  }
  return undefined;
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return undefined;
  }
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0];
}

function resolveModuleFile(
  program: ts.Program,
  containingFile: string,
  specifier: string,
): string | undefined {
  const compilerOptions = program.getCompilerOptions();
  const host = ts.createCompilerHost(compilerOptions);
  const resolved = ts.resolveModuleName(specifier, containingFile, compilerOptions, host);
  return resolved.resolvedModule?.resolvedFileName;
}

function isProjectSourceFile(fileName: string, program: ts.Program): boolean {
  const normalized = path.normalize(fileName);
  if (normalized.includes(`${path.sep}node_modules${path.sep}`)) {
    return false;
  }
  return program.getSourceFile(fileName) !== undefined && !fileName.endsWith('.d.ts');
}

function isUntypedDependencyFile(fileName: string): boolean {
  const normalized = path.normalize(fileName);
  if (!normalized.includes(`${path.sep}node_modules${path.sep}`)) {
    return false;
  }
  return !fileName.endsWith('.d.ts');
}

function isAnyLikeType(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.flags & ts.TypeFlags.Any) {
    return true;
  }
  const text = checker.typeToString(type);
  return text === 'any' || text === 'error';
}

function resolveSourceFile(
  finding: Finding,
  sourceFileByPath: Map<string, ts.SourceFile>,
  rootDir: string,
): ts.SourceFile | undefined {
  return (
    sourceFileByPath.get(finding.file) ??
    sourceFileByPath.get(path.resolve(rootDir, finding.file)) ??
    sourceFileByPath.get(path.normalize(path.resolve(rootDir, finding.file)))
  );
}

/**
 * Collect implicit any diagnostics when --include-implicit is set.
 */
export function findImplicitAny(program: ts.Program, rootDir: string): Finding[] {
  const findings: Finding[] = [];
  const diagnostics = [...program.getSemanticDiagnostics(), ...program.getSyntacticDiagnostics()];

  const implicitCodes = new Set([
    7006, // Parameter implicitly has an 'any' type
    7019, // Rest parameter implicitly has an 'any[]' type
    7031, // Binding element implicitly has an 'any' type
    7034, // Variable implicitly has type 'any'
    7005, // Variable implicitly has an 'any' type
    7008, // Member implicitly has an 'any' type
    7043, // Variable implicitly has type 'any' (no initializer / not written)
    7053, // Element implicitly has an 'any' type
  ]);

  for (const diagnostic of diagnostics) {
    if (!diagnostic.file || diagnostic.start === undefined) {
      continue;
    }
    if (!implicitCodes.has(diagnostic.code)) {
      continue;
    }

    const sourceFile = diagnostic.file;
    const start = diagnostic.start;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
    const relativeFile = toRelative(sourceFile.fileName, rootDir);
    const snippetInfo = extractSnippetInfo(sourceFile, start);
    const kind: AnyKind = 'implicit';
    const id = createFindingId(relativeFile, line + 1, character + 1, kind);
    const proxyNode = {
      getStart: () => diagnostic.start!,
      getEnd: () => diagnostic.start! + (diagnostic.length ?? 1),
      kind: ts.SyntaxKind.Identifier,
      parent: sourceFile,
    } as unknown as ts.Node;

    if (isIgnoredAt(sourceFile, proxyNode, id)) {
      continue;
    }

    findings.push({
      id,
      file: relativeFile,
      line: line + 1,
      column: character + 1,
      kind,
      snippet: snippetInfo.text,
      snippetAnyOffset: snippetInfo.anyOffset,
      symbolName: extractImplicitSymbolName(sourceFile, start),
      nodeStart: start,
      nodeEnd: start + (diagnostic.length ?? 1),
      implicit: true,
      suggestion: {
        typeText: 'unknown',
        confidence: 'low',
        why: 'implicit any from noImplicitAny diagnostic',
        evidence: ['implicit any diagnostic'],
        assignable: true,
      },
    });
  }

  return findings;
}
