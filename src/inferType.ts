import path from 'node:path';
import ts from 'typescript';
import { findNodeAt } from './ast.js';
import {
  type Confidence,
  type Finding,
  HIGH_CONFIDENCE,
  LOW_CONFIDENCE,
  MEDIUM_CONFIDENCE,
  NUMBER_METHODS,
  STRING_METHODS,
  type Suggestion,
  UNKNOWN_FALLBACK,
  WIDE_UNION_MEMBER_LIMIT,
} from './types.js';

const MAX_NAMED_TYPE_CANDIDATES = 200;
const MAX_USAGE_PROPERTIES = 12;
const INFER_FROM_USAGE_ERROR_CODES = [7006, 7005, 7008, 7019, 7031, 7034, 7043, 7053];

interface InferenceContext {
  program: ts.Program;
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
  namedTypes: NamedTypeEntry[];
  getLanguageService?: () => ts.LanguageService;
}

interface NamedTypeEntry {
  name: string;
  type: ts.Type;
  symbol: ts.Symbol;
  fileName: string;
  propertyNames: Set<string>;
}

interface PropertyUsage {
  typeTexts: Set<string>;
  evidence: string[];
}

interface UsageSites {
  identifiers: ts.Identifier[];
  expressions: ts.Expression[];
}

interface DraftSuggestion extends Suggestion {
  useSites?: UsageSites;
}

export function attachSuggestions(
  findings: Finding[],
  program: ts.Program,
  checker: ts.TypeChecker,
  sourceFileByPath: Map<string, ts.SourceFile>,
  rootDir: string,
): Finding[] {
  const namedTypes = collectNamedTypes(program, checker);
  let languageService: ts.LanguageService | undefined;
  const getLanguageService = (): ts.LanguageService => {
    languageService ??= createProgramLanguageService(program);
    return languageService;
  };

  return findings.map((finding) => {
    const absolutePath = resolveAbsolute(finding.file, rootDir);
    const sourceFile =
      sourceFileByPath.get(absolutePath) ??
      sourceFileByPath.get(path.normalize(absolutePath)) ??
      sourceFileByPath.get(finding.file);

    const ctx: InferenceContext = {
      program,
      checker,
      sourceFile: sourceFile ?? program.getSourceFiles()[0]!,
      namedTypes,
      getLanguageService,
    };

    if (!sourceFile) {
      return finalizeFinding(ctx, finding, unknownSuggestion('source file unavailable'));
    }

    ctx.sourceFile = sourceFile;

    if (finding.implicit) {
      const fromLs = inferImplicitFromLanguageService(ctx, finding);
      if (fromLs) {
        return finalizeFinding(ctx, finding, preferNamedType(ctx, fromLs));
      }
      return finalizeFinding(
        ctx,
        finding,
        finding.suggestion ?? unknownSuggestion('implicit any from noImplicitAny diagnostic'),
      );
    }

    const anyNode = findNodeAt(sourceFile, finding.nodeStart, finding.nodeEnd);
    if (!anyNode) {
      return finalizeFinding(ctx, finding, unknownSuggestion('node not found'));
    }

    const suggestion = inferSuggestion(ctx, anyNode, finding);
    return finalizeFinding(ctx, finding, suggestion);
  });
}

function inferSuggestion(ctx: InferenceContext, anyNode: ts.Node, finding: Finding): Suggestion {
  if (finding.kind === 'assertion') {
    const fromJsx = inferFromJsxContextualType(ctx, anyNode);
    if (fromJsx) {
      return preferNamedType(ctx, fromJsx);
    }
    const fromAssertion = inferFromContextualType(ctx, anyNode);
    if (fromAssertion) {
      return preferNamedType(ctx, fromAssertion);
    }
    return unknownSuggestion('assertion without safe contextual type');
  }

  const fromContainer = inferFromContainerInnerType(ctx, anyNode);
  if (fromContainer) {
    return preferNamedType(ctx, fromContainer);
  }

  const fromInitializer = inferFromInitializer(ctx, anyNode);
  if (fromInitializer) {
    return preferNamedType(ctx, fromInitializer);
  }

  const fromClassField = inferFromClassFieldAssignment(ctx, anyNode);
  if (fromClassField) {
    return preferNamedType(ctx, fromClassField);
  }

  const fromDestructure = inferFromDestructuring(ctx, anyNode);
  if (fromDestructure) {
    return preferNamedType(ctx, fromDestructure);
  }

  const fromReturn = inferFromReturnExpression(ctx, anyNode);
  if (fromReturn) {
    return preferNamedType(ctx, fromReturn);
  }

  const fromJsx = inferFromJsxContextualType(ctx, anyNode);
  if (fromJsx) {
    return preferNamedType(ctx, fromJsx);
  }

  const fromContextual = inferFromContextualType(ctx, anyNode);
  if (fromContextual) {
    return preferNamedType(ctx, fromContextual);
  }

  const fromMapCallback = inferFromMapCallback(ctx, anyNode);
  if (fromMapCallback) {
    return preferNamedType(ctx, fromMapCallback);
  }

  const fromUsage = inferFromUsage(ctx, anyNode);
  if (fromUsage) {
    return preferNamedType(ctx, fromUsage);
  }

  const fromLs = inferExplicitViaStrippedLanguageService(ctx, anyNode, finding);
  if (fromLs) {
    return preferNamedType(ctx, fromLs);
  }

  return unknownSuggestion('no provable type from initializer, context, or usage');
}

function finalizeFinding(ctx: InferenceContext, finding: Finding, draft: DraftSuggestion): Finding {
  const evidence = [...(draft.evidence ?? [])];
  let confidence = draft.confidence;
  let assignable = draft.assignable ?? true;

  if (isWideTypeText(draft.typeText)) {
    confidence = downgradeConfidence(confidence);
    evidence.push(`wide type ${draft.typeText}`);
  }

  if (draft.typeText !== UNKNOWN_FALLBACK && !isForbiddenSuggestion(draft.typeText)) {
    const check = checkAssignableAtUseSites(ctx, draft);
    assignable = check.assignable;
    if (!check.assignable) {
      confidence = confidence === HIGH_CONFIDENCE ? MEDIUM_CONFIDENCE : LOW_CONFIDENCE;
      evidence.push(...check.failures);
    }
  }

  if (isForbiddenSuggestion(draft.typeText)) {
    const safe = unknownSuggestion('forbidden any suggestion blocked');
    return {
      ...finding,
      suggestion: { ...safe, evidence, assignable: true },
      safeSuggestion: { ...safe, evidence: ['safe fallback'], assignable: true },
      fixable: false,
    };
  }

  const best: Suggestion = {
    typeText: draft.typeText,
    confidence,
    why: draft.why,
    evidence: evidence.length > 0 ? evidence : undefined,
    assignable,
  };

  const speculative = confidence !== HIGH_CONFIDENCE || best.assignable === false;
  const safeSuggestion: Suggestion = speculative
    ? {
        typeText: UNKNOWN_FALLBACK,
        confidence: LOW_CONFIDENCE,
        why: 'safe fallback when best is speculative',
        evidence: ['safe: unknown'],
        assignable: true,
      }
    : { ...best };

  const fixable = isSuggestionFixable(best, finding);

  return {
    ...finding,
    suggestion: best,
    safeSuggestion,
    fixable,
  };
}

function isSuggestionFixable(suggestion: Suggestion, finding: Finding): boolean {
  if (finding.implicit) {
    return false;
  }
  if (suggestion.confidence !== HIGH_CONFIDENCE) {
    return false;
  }
  if (suggestion.assignable === false) {
    return false;
  }
  const typeText = suggestion.typeText.trim();
  if (!typeText || isForbiddenSuggestion(typeText)) {
    return false;
  }
  return true;
}

function checkAssignableAtUseSites(
  ctx: InferenceContext,
  draft: DraftSuggestion,
): {
  assignable: boolean;
  failures: string[];
} {
  if (draft.assignable === false) {
    return {
      assignable: false,
      failures: draft.evidence?.filter((item) => item.startsWith('not assignable')) ?? [
        'not assignable at use site',
      ],
    };
  }

  const resolved = resolveSuggestionType(ctx, draft.typeText);
  if (!resolved || !draft.useSites) {
    return { assignable: true, failures: [] };
  }

  const failures: string[] = [];

  for (const identifier of draft.useSites.identifiers) {
    const expected = getExpectedTypeWhenUsedAsArgument(ctx, identifier);
    if (!expected || isUnusableType(expected.type, ctx.checker)) {
      continue;
    }
    if (!ctx.checker.isTypeAssignableTo(resolved, expected.type)) {
      failures.push(
        `not assignable at call-site ${expected.callee}: ${draft.typeText} ↛ ${printType(ctx, expected.type)}`,
      );
    }
  }

  for (const expression of draft.useSites.expressions) {
    const contextual = ctx.checker.getContextualType(expression);
    if (!contextual || isUnusableType(contextual, ctx.checker)) {
      continue;
    }
    if (!ctx.checker.isTypeAssignableTo(resolved, contextual)) {
      failures.push(`not assignable to contextual ${printType(ctx, contextual)}`);
    }
  }

  return {
    assignable: failures.length === 0,
    failures,
  };
}

function resolveSuggestionType(ctx: InferenceContext, typeText: string): ts.Type | undefined {
  // Exact named types use the precomputed checker type. Generics such as
  // Partial<User> go through parseTypeViaTemp — getTypeAtLocation on a missing
  // valueDeclaration (falling back to SourceFile) throws inside TypeScript.
  const exact = pickNamedType(ctx, typeText);
  if (exact) {
    return exact.type;
  }

  return parseTypeViaTemp(ctx, typeText);
}

/**
 * Filter named types by name; prefer a same-file entry, else the first match.
 */
function pickNamedType(ctx: InferenceContext, name: string): NamedTypeEntry | undefined {
  const matches = ctx.namedTypes.filter((entry) => entry.name === name);
  if (matches.length === 0) {
    return undefined;
  }
  const sourceFileName = path.normalize(ctx.sourceFile.fileName);
  const sameFile = matches.find((entry) => path.normalize(entry.fileName) === sourceFileName);
  return sameFile ?? matches[0];
}

function downgradeConfidence(confidence: Confidence): Confidence {
  if (confidence === HIGH_CONFIDENCE) {
    return MEDIUM_CONFIDENCE;
  }
  return LOW_CONFIDENCE;
}

function isWideTypeText(typeText: string): boolean {
  const normalized = typeText.trim();
  if (normalized === 'Object' || normalized === '{}' || normalized === 'object') {
    return true;
  }
  if (normalized.includes('|')) {
    const parts = normalized
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= WIDE_UNION_MEMBER_LIMIT) {
      return true;
    }
  }
  return false;
}

function inferFromInitializer(
  ctx: InferenceContext,
  anyNode: ts.Node,
): DraftSuggestion | undefined {
  const annotated = findAnnotatedDeclaration(anyNode);
  if (!annotated) {
    return undefined;
  }

  if (ts.isVariableDeclaration(annotated) && annotated.initializer) {
    return typeFromExpression(ctx, annotated.initializer, 'initializer');
  }

  if (ts.isPropertyDeclaration(annotated) && annotated.initializer) {
    return typeFromExpression(ctx, annotated.initializer, 'property initializer');
  }

  if (ts.isParameter(annotated) && annotated.initializer) {
    return typeFromExpression(ctx, annotated.initializer, 'parameter default');
  }

  return undefined;
}

function inferFromClassFieldAssignment(
  ctx: InferenceContext,
  anyNode: ts.Node,
): DraftSuggestion | undefined {
  const annotated = findAnnotatedDeclaration(anyNode);
  if (!annotated || !ts.isPropertyDeclaration(annotated)) {
    return undefined;
  }

  const nameNode = annotated.name;
  if (!ts.isIdentifier(nameNode)) {
    return undefined;
  }

  const symbol = ctx.checker.getSymbolAtLocation(nameNode);
  if (!symbol) {
    return undefined;
  }

  const types: ts.Type[] = [];
  const evidence: string[] = [];

  for (const reference of findIdentifierReferences(ctx, symbol)) {
    const parent = reference.parent;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.name === reference &&
      ts.isBinaryExpression(parent.parent) &&
      parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.parent.left === parent
    ) {
      const rhsType = ctx.checker.getTypeAtLocation(parent.parent.right);
      if (!isUnusableType(rhsType, ctx.checker)) {
        types.push(rhsType);
        evidence.push(`class field ${nameNode.text} = ${printType(ctx, rhsType)}`);
      }
    }
  }

  if (types.length === 0) {
    return undefined;
  }

  return suggestionFromTypes(ctx, types, 'class field assignment', evidence);
}

function inferFromDestructuring(
  ctx: InferenceContext,
  anyNode: ts.Node,
): DraftSuggestion | undefined {
  const parameter = findAnnotatedDeclaration(anyNode);
  if (!parameter || !ts.isParameter(parameter)) {
    return undefined;
  }

  if (!ts.isObjectBindingPattern(parameter.name) && !ts.isArrayBindingPattern(parameter.name)) {
    return undefined;
  }

  const contextual = getParameterContextualType(ctx, parameter);
  if (contextual) {
    return {
      ...contextual,
      evidence: [...(contextual.evidence ?? []), 'destructuring parameter pattern'],
    };
  }

  // Infer object shape from binding element names when used
  if (ts.isObjectBindingPattern(parameter.name)) {
    const props: string[] = [];
    const evidence: string[] = [];
    for (const element of parameter.name.elements) {
      if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
        props.push(element.name.text);
        evidence.push(`destructure .${element.name.text}`);
      }
    }
    if (props.length > 0) {
      const typeText = `{ ${props.map((name) => `${name}: unknown`).join('; ')} }`;
      return {
        typeText,
        confidence: MEDIUM_CONFIDENCE,
        why: 'object destructuring binding pattern',
        evidence,
      };
    }
  }

  return undefined;
}

function inferFromMapCallback(
  ctx: InferenceContext,
  anyNode: ts.Node,
): DraftSuggestion | undefined {
  const parameter = findAnnotatedDeclaration(anyNode);
  if (!parameter || !ts.isParameter(parameter)) {
    return undefined;
  }

  const fn = parameter.parent;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) {
    return undefined;
  }

  const call = fn.parent;
  if (!ts.isCallExpression(call)) {
    return undefined;
  }

  if (!ts.isPropertyAccessExpression(call.expression)) {
    return undefined;
  }

  const methodName = call.expression.name.text;
  if (
    ![
      'map',
      'filter',
      'forEach',
      'find',
      'findIndex',
      'some',
      'every',
      'flatMap',
      'reduce',
    ].includes(methodName)
  ) {
    return undefined;
  }

  const paramIndex = fn.parameters.indexOf(parameter);
  if (paramIndex !== 0 && !(methodName === 'reduce' && paramIndex === 1)) {
    // element callback is usually first param (reduce accumulator is first)
    if (!(methodName === 'reduce' && paramIndex === 0)) {
      // allow first param always
    }
  }

  const receiverType = ctx.checker.getTypeAtLocation(call.expression.expression);
  const evidence: string[] = [`array callback .${methodName}`];

  if (methodName === 'reduce' && paramIndex === 0) {
    // accumulator — try contextual from reduce signature
    const contextual = ctx.checker.getContextualType(fn);
    if (contextual) {
      const signatures = contextual.getCallSignatures();
      const signature = signatures[0];
      const param = signature?.getParameters()[0];
      if (param) {
        const type = ctx.checker.getTypeOfSymbolAtLocation(param, fn);
        if (!isUnusableType(type, ctx.checker)) {
          return suggestionFromTypes(ctx, [type], 'reduce accumulator contextual type', evidence);
        }
      }
    }
    return undefined;
  }

  // Element type from array
  const elementType = getArrayElementType(ctx, receiverType);
  if (elementType && !isUnusableType(elementType, ctx.checker)) {
    evidence.push(`element type ${printType(ctx, elementType)}`);
    return suggestionFromTypes(
      ctx,
      [elementType],
      `from .${methodName} array element type`,
      evidence,
    );
  }

  return undefined;
}

function getArrayElementType(ctx: InferenceContext, type: ts.Type): ts.Type | undefined {
  try {
    const numberIndex = type.getNumberIndexType();
    if (numberIndex) {
      return numberIndex;
    }

    if (type.flags & ts.TypeFlags.Object) {
      const objectFlags = (type as ts.ObjectType).objectFlags;
      if (objectFlags & ts.ObjectFlags.Reference) {
        const typeArgs = ctx.checker.getTypeArguments(type as ts.TypeReference);
        if (typeArgs.length > 0) {
          return typeArgs[0];
        }
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function inferFromReturnExpression(
  ctx: InferenceContext,
  anyNode: ts.Node,
): DraftSuggestion | undefined {
  const fn = findEnclosingFunction(anyNode);
  if (!fn || !fn.type || !typeNodeContains(fn.type, anyNode)) {
    return undefined;
  }

  if (!fn.body) {
    return undefined;
  }

  const returnExpressions = collectReturnExpressions(fn.body);
  if (returnExpressions.length === 0) {
    return undefined;
  }

  const types = returnExpressions.map((expression) => ctx.checker.getTypeAtLocation(expression));
  if (types.some((type) => isUnusableType(type, ctx.checker))) {
    if (types.every((type) => looksLikeJsonParse(returnExpressions[types.indexOf(type)!]))) {
      return unknownSuggestion('return value from JSON.parse');
    }
  }

  const usable = types.filter((type) => !isUnusableType(type, ctx.checker));
  if (usable.length === 0) {
    return unknownSuggestion('return expressions are any/unknown');
  }

  const evidence = usable.map((type) => `return ${printType(ctx, type)}`);
  return suggestionFromTypes(ctx, usable, 'inferred from return expression', evidence);
}

function inferFromJsxContextualType(
  ctx: InferenceContext,
  anyNode: ts.Node,
): DraftSuggestion | undefined {
  let current: ts.Node | undefined = anyNode;
  while (current) {
    if (ts.isJsxExpression(current) && current.expression) {
      const contextual =
        ctx.checker.getContextualType(current.expression) ??
        ctx.checker.getContextualType(current as unknown as ts.Expression);
      if (contextual && !isUnusableType(contextual, ctx.checker)) {
        const typeText = printType(ctx, contextual);
        if (!isForbiddenSuggestion(typeText)) {
          const attrName = ts.isJsxAttribute(current.parent)
            ? current.parent.name.getText()
            : 'jsx';
          return {
            typeText,
            confidence: HIGH_CONFIDENCE,
            why: 'JSX attribute contextual type',
            evidence: [`jsx ${attrName}: ${typeText}`],
          };
        }
      }
    }

    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      const parent = current.parent;
      if (ts.isJsxExpression(parent)) {
        const contextual =
          ctx.checker.getContextualType(current as unknown as ts.Expression) ??
          ctx.checker.getContextualType(parent.expression ?? current.expression);
        if (contextual && !isUnusableType(contextual, ctx.checker)) {
          const typeText = printType(ctx, contextual);
          if (!isForbiddenSuggestion(typeText)) {
            return {
              typeText,
              confidence: HIGH_CONFIDENCE,
              why: 'JSX attribute contextual type',
              evidence: [`jsx contextual ${typeText}`],
            };
          }
        }
      }
    }

    current = current.parent;
  }

  return undefined;
}

function inferFromContainerInnerType(
  ctx: InferenceContext,
  anyNode: ts.Node,
): DraftSuggestion | undefined {
  const typeRef = findParentTypeReference(anyNode);
  if (!typeRef) {
    return undefined;
  }

  const typeName = getTypeReferenceName(typeRef);
  if (!typeName) {
    return undefined;
  }

  const containerNames = new Set([
    'Promise',
    'Observable',
    'Array',
    'ReadonlyArray',
    'Set',
    'WeakSet',
  ]);

  if (!containerNames.has(typeName)) {
    // Map / Record / Partial handled via generic named match later
    if (typeName !== 'Map' && typeName !== 'WeakMap' && typeName !== 'Record') {
      return undefined;
    }
  }

  const declaration = findAnnotatedDeclaration(anyNode);
  if (!declaration) {
    return undefined;
  }

  const nameNode = getDeclarationName(declaration);
  const symbol = nameNode ? ctx.checker.getSymbolAtLocation(nameNode) : undefined;
  const evidence: string[] = [];
  const innerTypes: ts.Type[] = [];

  if (symbol && (typeName === 'Promise' || typeName === 'Observable')) {
    for (const reference of findIdentifierReferences(ctx, symbol)) {
      const awaited = getAwaitedInnerType(ctx, reference);
      if (awaited) {
        innerTypes.push(awaited.type);
        evidence.push(awaited.evidence);
      }
    }
  }

  if (symbol && (typeName === 'Array' || typeName === 'ReadonlyArray')) {
    for (const reference of findIdentifierReferences(ctx, symbol)) {
      const element = getArrayPushOrIndexType(ctx, reference);
      if (element) {
        innerTypes.push(element.type);
        evidence.push(element.evidence);
      }
    }
  }

  if (innerTypes.length === 0) {
    return undefined;
  }

  const innerText = combineTypeTexts(
    innerTypes.map((type) => {
      const named = findAssignableNamedType(ctx, type, ctx.sourceFile.fileName);
      return named ?? printType(ctx, type);
    }),
  );

  if (isForbiddenSuggestion(innerText)) {
    return undefined;
  }

  const typeText = `${typeName}<${innerText}>`;
  const confidence =
    innerTypes.length === 1 && isConcreteType(innerTypes[0]!, ctx.checker)
      ? HIGH_CONFIDENCE
      : MEDIUM_CONFIDENCE;

  return {
    typeText,
    confidence,
    why: `inferred ${typeName} inner type from usage`,
    evidence,
  };
}

function getAwaitedInnerType(
  ctx: InferenceContext,
  reference: ts.Identifier,
): { type: ts.Type; evidence: string } | undefined {
  const parent = reference.parent;

  // await ref
  if (ts.isAwaitExpression(parent) && parent.expression === reference) {
    const type = ctx.checker.getTypeAtLocation(parent);
    if (!isUnusableType(type, ctx.checker)) {
      return { type, evidence: `await → ${printType(ctx, type)}` };
    }
  }

  // ref.then(x => ...)
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === reference &&
    (parent.name.text === 'then' || parent.name.text === 'catch') &&
    ts.isCallExpression(parent.parent)
  ) {
    const call = parent.parent;
    const callback = call.arguments[0];
    if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
      const param = callback.parameters[0];
      if (param?.type) {
        const type = ctx.checker.getTypeFromTypeNode(param.type);
        if (!isUnusableType(type, ctx.checker)) {
          return { type, evidence: `.then param → ${printType(ctx, type)}` };
        }
      }
      // Infer from callback body usage of the param
      if (param && ts.isIdentifier(param.name)) {
        const contextual = ctx.checker.getTypeAtLocation(param.name);
        if (!isUnusableType(contextual, ctx.checker)) {
          return { type: contextual, evidence: `.then callback param` };
        }
      }
    }
  }

  // yield ref (generator)
  if (ts.isYieldExpression(parent) && parent.expression === reference) {
    const type = ctx.checker.getTypeAtLocation(reference);
    // Not very useful; skip
    void type;
  }

  return undefined;
}

function getArrayPushOrIndexType(
  ctx: InferenceContext,
  reference: ts.Identifier,
): { type: ts.Type; evidence: string } | undefined {
  const parent = reference.parent;

  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === reference &&
    parent.name.text === 'push' &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.arguments.length > 0
  ) {
    const argType = ctx.checker.getTypeAtLocation(parent.parent.arguments[0]!);
    if (!isUnusableType(argType, ctx.checker)) {
      return { type: argType, evidence: `push(${printType(ctx, argType)})` };
    }
  }

  if (ts.isElementAccessExpression(parent) && parent.expression === reference) {
    if (
      ts.isBinaryExpression(parent.parent) &&
      parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.parent.left === parent
    ) {
      const rhs = ctx.checker.getTypeAtLocation(parent.parent.right);
      if (!isUnusableType(rhs, ctx.checker)) {
        return { type: rhs, evidence: `index assign ${printType(ctx, rhs)}` };
      }
    }
  }

  return undefined;
}

function findParentTypeReference(anyNode: ts.Node): ts.TypeReferenceNode | undefined {
  let current: ts.Node | undefined = anyNode.parent;
  while (current) {
    if (ts.isTypeReferenceNode(current)) {
      return current;
    }
    if (
      ts.isParameter(current) ||
      ts.isVariableDeclaration(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isFunctionLike(current) ||
      ts.isAsExpression(current)
    ) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function getTypeReferenceName(typeRef: ts.TypeReferenceNode): string | undefined {
  if (ts.isIdentifier(typeRef.typeName)) {
    return typeRef.typeName.text;
  }
  if (ts.isQualifiedName(typeRef.typeName)) {
    return typeRef.typeName.right.text;
  }
  return undefined;
}

function inferFromContextualType(
  ctx: InferenceContext,
  anyNode: ts.Node,
): DraftSuggestion | undefined {
  const parent = anyNode.parent;

  if (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) {
    return inferAssertionContext(ctx, parent);
  }

  const declaration = findAnnotatedDeclaration(anyNode);
  if (declaration && ts.isParameter(declaration)) {
    return getParameterContextualType(ctx, declaration);
  }

  return undefined;
}

function inferAssertionContext(
  ctx: InferenceContext,
  assertion: ts.AsExpression | ts.TypeAssertion,
): DraftSuggestion | undefined {
  const expression = assertion.expression;

  if (isJsonParseCall(expression)) {
    return unknownSuggestion('JSON.parse result');
  }

  const contextual =
    ctx.checker.getContextualType(assertion as unknown as ts.Expression) ??
    ctx.checker.getContextualType(expression);

  if (contextual && !isUnusableType(contextual, ctx.checker)) {
    const typeText = printType(ctx, contextual);
    if (!isForbiddenSuggestion(typeText)) {
      return {
        typeText,
        confidence: HIGH_CONFIDENCE,
        why: 'contextual type at assertion site',
        evidence: [`assertion context ${typeText}`],
      };
    }
  }

  const expressionType = ctx.checker.getTypeAtLocation(expression);
  if (!isUnusableType(expressionType, ctx.checker)) {
    const typeText = printType(ctx, expressionType);
    if (!isForbiddenSuggestion(typeText)) {
      return {
        typeText,
        confidence: MEDIUM_CONFIDENCE,
        why: 'type of asserted expression',
        evidence: [`asserted expression ${typeText}`],
      };
    }
  }

  return undefined;
}

function getParameterContextualType(
  ctx: InferenceContext,
  parameter: ts.ParameterDeclaration,
): DraftSuggestion | undefined {
  return inferParameterFromCallSignatures(ctx, parameter);
}

function inferParameterFromCallSignatures(
  ctx: InferenceContext,
  parameter: ts.ParameterDeclaration,
): DraftSuggestion | undefined {
  const fn = parameter.parent;
  if (!ts.isFunctionLike(fn)) {
    return undefined;
  }

  const paramIndex = fn.parameters.indexOf(parameter);
  if (paramIndex < 0) {
    return undefined;
  }

  const types: ts.Type[] = [];
  const evidence: string[] = [];

  const nameNode = parameter.name && ts.isIdentifier(parameter.name) ? parameter.name : undefined;
  const paramSymbol = nameNode ? ctx.checker.getSymbolAtLocation(nameNode) : undefined;

  if (paramSymbol) {
    for (const reference of findIdentifierReferences(ctx, paramSymbol)) {
      const expected = getExpectedTypeWhenUsedAsArgument(ctx, reference);
      if (expected && !isUnusableType(expected.type, ctx.checker)) {
        types.push(expected.type);
        evidence.push(`call-site ${expected.callee}(${printType(ctx, expected.type)})`);
      }
    }
  }

  if (fn.name && ts.isIdentifier(fn.name)) {
    const fnSymbol = ctx.checker.getSymbolAtLocation(fn.name);
    if (fnSymbol) {
      for (const referenceNode of findIdentifierReferences(ctx, fnSymbol)) {
        const call = findEnclosingCallWhereCallee(referenceNode);
        if (!call || call.arguments.length <= paramIndex) {
          continue;
        }
        const arg = call.arguments[paramIndex]!;
        const argType = ctx.checker.getTypeAtLocation(arg);
        if (!isUnusableType(argType, ctx.checker)) {
          types.push(argType);
          evidence.push(`fn call arg ${printType(ctx, argType)}`);
        }
      }
    }
  }

  const contextualParam = getContextualParameterType(ctx, fn, paramIndex);
  if (contextualParam && !isUnusableType(contextualParam, ctx.checker)) {
    types.push(contextualParam);
    evidence.push(`contextual param ${printType(ctx, contextualParam)}`);
  }

  if (types.length === 0) {
    return undefined;
  }

  return suggestionFromTypes(ctx, types, 'inferred from call-site / contextual types', evidence);
}

function getExpectedTypeWhenUsedAsArgument(
  ctx: InferenceContext,
  identifier: ts.Identifier,
): { type: ts.Type; callee: string } | undefined {
  const parent = identifier.parent;
  if (!ts.isCallExpression(parent)) {
    return undefined;
  }

  const argIndex = parent.arguments.indexOf(identifier);
  if (argIndex < 0) {
    return undefined;
  }

  const signature = ctx.checker.getResolvedSignature(parent);
  if (!signature) {
    return undefined;
  }

  const params = signature.getParameters();
  const param = params[argIndex];
  if (!param) {
    return undefined;
  }

  const type = ctx.checker.getTypeOfSymbolAtLocation(param, parent);
  const callee = parent.expression.getText();
  return { type, callee };
}

function findEnclosingCallWhereCallee(referenceNode: ts.Node): ts.CallExpression | undefined {
  const parent = referenceNode.parent;
  if (ts.isCallExpression(parent) && parent.expression === referenceNode) {
    return parent;
  }
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.name === referenceNode &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    return parent.parent;
  }
  return undefined;
}

function getContextualParameterType(
  ctx: InferenceContext,
  fn: ts.SignatureDeclaration,
  paramIndex: number,
): ts.Type | undefined {
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === fn) {
    const contextual = ctx.checker.getContextualType(fn as unknown as ts.Expression);
    if (!contextual) {
      return undefined;
    }
    const signatures = contextual.getCallSignatures();
    const signature = signatures[0];
    if (!signature) {
      return undefined;
    }
    const params = signature.getParameters();
    const param = params[paramIndex];
    if (!param) {
      return undefined;
    }
    return ctx.checker.getTypeOfSymbolAtLocation(param, fn);
  }

  return undefined;
}

function inferFromUsage(ctx: InferenceContext, anyNode: ts.Node): DraftSuggestion | undefined {
  const declaration = findAnnotatedDeclaration(anyNode);
  if (!declaration) {
    return undefined;
  }

  const nameNode = getDeclarationName(declaration);
  if (!nameNode) {
    return undefined;
  }

  const symbol = ctx.checker.getSymbolAtLocation(nameNode);
  if (!symbol) {
    return undefined;
  }

  const properties = new Map<string, PropertyUsage>();
  let usedAsString = false;
  let usedAsNumber = false;
  let usedAsBoolean = false;
  let usedAsCallable = false;
  const evidence: string[] = [];
  const useSites: UsageSites = { identifiers: [], expressions: [] };

  for (const reference of findIdentifierReferences(ctx, symbol)) {
    useSites.identifiers.push(reference);
    const parent = reference.parent;

    if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
      const propName = parent.name.text;
      const info = properties.get(propName) ?? { typeTexts: new Set(), evidence: [] };
      inferPropertyTypeFromAccess(ctx, parent, info);
      properties.set(propName, info);
      continue;
    }

    if (ts.isElementAccessExpression(parent) && parent.expression === reference) {
      if (ts.isStringLiteral(parent.argumentExpression)) {
        const propName = parent.argumentExpression.text;
        const info = properties.get(propName) ?? { typeTexts: new Set(), evidence: [] };
        inferPropertyTypeFromElementAccess(ctx, parent, info);
        properties.set(propName, info);
      }
      continue;
    }

    if (ts.isCallExpression(parent) && parent.expression === reference) {
      usedAsCallable = true;
      evidence.push('called as function');
      continue;
    }

    const asArg = getExpectedTypeWhenUsedAsArgument(ctx, reference);
    if (asArg && !isUnusableType(asArg.type, ctx.checker)) {
      const named = findAssignableNamedType(ctx, asArg.type, ctx.sourceFile.fileName);
      const typeText = named ?? printType(ctx, asArg.type);
      if (!isForbiddenSuggestion(typeText)) {
        evidence.push(`call-site ${asArg.callee}(${typeText})`);
        return {
          typeText,
          confidence: HIGH_CONFIDENCE,
          why: 'inferred from call-site expected argument type',
          evidence,
          useSites,
        };
      }
    }

    if (ts.isBinaryExpression(parent)) {
      if (isArithmeticOperator(parent.operatorToken.kind)) {
        usedAsNumber = true;
        evidence.push('arithmetic operator');
      }
      if (parent.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const other = parent.left === reference ? parent.right : parent.left;
        const otherType = ctx.checker.getTypeAtLocation(other);
        if (otherType.flags & ts.TypeFlags.StringLike) {
          usedAsString = true;
          evidence.push('string concatenation');
        } else if (otherType.flags & ts.TypeFlags.NumberLike) {
          usedAsNumber = true;
          evidence.push('numeric +');
        }
      }
    }

    if (
      ts.isCallExpression(parent) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      parent.expression.expression === reference
    ) {
      const method = parent.expression.name.text;
      if ((STRING_METHODS as readonly string[]).includes(method)) {
        usedAsString = true;
        evidence.push(`method .${method}`);
      }
      if ((NUMBER_METHODS as readonly string[]).includes(method)) {
        usedAsNumber = true;
        evidence.push(`method .${method}`);
      }
    }

    if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
      if (
        parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken ||
        parent.operator === ts.SyntaxKind.PlusToken ||
        parent.operator === ts.SyntaxKind.MinusToken
      ) {
        usedAsNumber = true;
        evidence.push('numeric unary');
      }
      if (parent.operator === ts.SyntaxKind.ExclamationToken) {
        usedAsBoolean = true;
        evidence.push('boolean unary');
      }
    }
  }

  if (properties.size > 0) {
    const props = [...properties.entries()].slice(0, MAX_USAGE_PROPERTIES);
    const propEvidence = props.flatMap(([, info]) => info.evidence);
    const typeText = `{ ${props
      .map(([name, info]) => {
        const propType =
          info.typeTexts.size > 0 ? combineTypeTexts([...info.typeTexts]) : UNKNOWN_FALLBACK;
        return `${name}: ${propType}`;
      })
      .join('; ')} }`;

    return {
      typeText,
      confidence: MEDIUM_CONFIDENCE,
      why: 'structural type from property access usage',
      evidence: [...evidence, ...propEvidence],
      useSites,
    };
  }

  if (usedAsCallable) {
    return {
      typeText: '(...args: unknown[]) => unknown',
      confidence: LOW_CONFIDENCE,
      why: 'used as callable',
      evidence,
      useSites,
    };
  }

  if (usedAsString && !usedAsNumber && !usedAsBoolean) {
    return {
      typeText: 'string',
      confidence: MEDIUM_CONFIDENCE,
      why: 'usage implies string',
      evidence,
      useSites,
    };
  }

  if (usedAsNumber && !usedAsString && !usedAsBoolean) {
    return {
      typeText: 'number',
      confidence: MEDIUM_CONFIDENCE,
      why: 'usage implies number',
      evidence,
      useSites,
    };
  }

  if (usedAsBoolean && !usedAsString && !usedAsNumber) {
    return {
      typeText: 'boolean',
      confidence: MEDIUM_CONFIDENCE,
      why: 'usage implies boolean',
      evidence,
      useSites,
    };
  }

  return undefined;
}

function inferPropertyTypeFromAccess(
  ctx: InferenceContext,
  access: ts.PropertyAccessExpression,
  info: PropertyUsage,
): void {
  const propName = access.name.text;
  const parent = access.parent;

  // Assignment: obj.prop = rhs
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === access
  ) {
    const rhsType = ctx.checker.getTypeAtLocation(parent.right);
    if (!isUnusableType(rhsType, ctx.checker)) {
      const text = printType(ctx, rhsType);
      if (!isForbiddenSuggestion(text)) {
        info.typeTexts.add(text);
        info.evidence.push(`prop .${propName} = ${text}`);
      }
    }
    return;
  }

  // Method call on property: obj.prop.split(...)
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === access &&
    ts.isCallExpression(parent.parent)
  ) {
    const method = parent.name.text;
    if ((STRING_METHODS as readonly string[]).includes(method)) {
      info.typeTexts.add('string');
      info.evidence.push(`prop .${propName}.${method} → string`);
      return;
    }
    if ((NUMBER_METHODS as readonly string[]).includes(method)) {
      info.typeTexts.add('number');
      info.evidence.push(`prop .${propName}.${method} → number`);
      return;
    }
  }

  // Direct method on the property access result when access itself is called — unlikely

  // Property passed as argument: takeId(obj.id)
  if (ts.isCallExpression(parent)) {
    const argIndex = parent.arguments.indexOf(access as unknown as ts.Expression);
    if (argIndex >= 0) {
      const signature = ctx.checker.getResolvedSignature(parent);
      const param = signature?.getParameters()[argIndex];
      if (param) {
        const expected = ctx.checker.getTypeOfSymbolAtLocation(param, parent);
        if (!isUnusableType(expected, ctx.checker)) {
          const text = printType(ctx, expected);
          if (!isForbiddenSuggestion(text)) {
            info.typeTexts.add(text);
            info.evidence.push(`prop .${propName} arg → ${text}`);
          }
        }
      }
    }
  }

  // Arithmetic on property
  if (ts.isBinaryExpression(parent) && isArithmeticOperator(parent.operatorToken.kind)) {
    info.typeTexts.add('number');
    info.evidence.push(`prop .${propName} arithmetic → number`);
  }

  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const other = parent.left === access ? parent.right : parent.left;
    const otherType = ctx.checker.getTypeAtLocation(other);
    if (otherType.flags & ts.TypeFlags.StringLike) {
      info.typeTexts.add('string');
      info.evidence.push(`prop .${propName} concat → string`);
    } else if (otherType.flags & ts.TypeFlags.NumberLike) {
      info.typeTexts.add('number');
      info.evidence.push(`prop .${propName} + number → number`);
    }
  }
}

function inferPropertyTypeFromElementAccess(
  ctx: InferenceContext,
  access: ts.ElementAccessExpression,
  info: PropertyUsage,
): void {
  const parent = access.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.left === access
  ) {
    const rhsType = ctx.checker.getTypeAtLocation(parent.right);
    if (!isUnusableType(rhsType, ctx.checker)) {
      const text = printType(ctx, rhsType);
      if (!isForbiddenSuggestion(text)) {
        info.typeTexts.add(text);
        info.evidence.push(`elem = ${text}`);
      }
    }
  }
}

function preferNamedType(ctx: InferenceContext, suggestion: DraftSuggestion): DraftSuggestion {
  const currentFile = ctx.sourceFile.fileName;

  if (suggestion.confidence === LOW_CONFIDENCE) {
    return suggestion;
  }

  if (suggestion.typeText === UNKNOWN_FALLBACK || isForbiddenSuggestion(suggestion.typeText)) {
    return suggestion;
  }

  // Already a simple named type or generic named type like Partial<User>
  if (/^[A-Z][A-Za-z0-9_]*(\s*<[^>]+>)?$/.test(suggestion.typeText)) {
    return suggestion;
  }

  // Container wrappers: Promise<X> — try to name the inner part
  const containerMatch = suggestion.typeText.match(
    /^(Promise|Observable|Array|ReadonlyArray|Set|WeakSet)<(.+)>$/,
  );
  if (containerMatch) {
    const [, container, inner] = containerMatch;
    const innerNamed = preferNamedType(ctx, {
      typeText: inner!,
      confidence: suggestion.confidence,
      why: suggestion.why,
      evidence: suggestion.evidence,
    });
    if (innerNamed.typeText !== inner) {
      return {
        ...suggestion,
        typeText: `${container}<${innerNamed.typeText}>`,
        why: `${suggestion.why}; named inner ${innerNamed.typeText}`,
        evidence: [
          ...(suggestion.evidence ?? []),
          ...(innerNamed.evidence ?? []),
          `named ${container}<${innerNamed.typeText}>`,
        ],
      };
    }
    return suggestion;
  }

  // Prefer property-set scoring for structural object texts
  if (suggestion.typeText.trim().startsWith('{')) {
    const byProps = findNamedTypeByProperties(ctx, suggestion.typeText, currentFile);
    if (byProps) {
      return {
        typeText: byProps.name,
        confidence: suggestion.confidence === HIGH_CONFIDENCE ? HIGH_CONFIDENCE : MEDIUM_CONFIDENCE,
        why: `${suggestion.why}; matched named type ${byProps.name}`,
        evidence: [
          ...(suggestion.evidence ?? []),
          `named ${byProps.name} (score ${byProps.score})`,
        ],
        useSites: suggestion.useSites,
        assignable: suggestion.assignable,
      };
    }
  }

  const inferredType = parseTypeViaTemp(ctx, suggestion.typeText);
  if (!inferredType || isUnusableType(inferredType, ctx.checker)) {
    return suggestion;
  }

  const match = findAssignableNamedTypeScored(ctx, inferredType, currentFile, suggestion.typeText);
  if (!match) {
    return suggestion;
  }

  return {
    typeText: match.name,
    confidence: suggestion.confidence === HIGH_CONFIDENCE ? HIGH_CONFIDENCE : MEDIUM_CONFIDENCE,
    why: `${suggestion.why}; matched named type ${match.name}`,
    evidence: [...(suggestion.evidence ?? []), `named ${match.name} (score ${match.score})`],
    useSites: suggestion.useSites,
    assignable: suggestion.assignable,
  };
}

function findAssignableNamedType(
  ctx: InferenceContext,
  inferredType: ts.Type,
  currentFile?: string,
): string | undefined {
  return findAssignableNamedTypeScored(ctx, inferredType, currentFile)?.name;
}

function findAssignableNamedTypeScored(
  ctx: InferenceContext,
  inferredType: ts.Type,
  currentFile?: string,
  structuralText?: string,
): { name: string; score: number } | undefined {
  let best: { name: string; score: number } | undefined;
  const inferredProps = new Set(
    ctx.checker
      .getApparentType(inferredType)
      .getProperties()
      .map((symbol) => symbol.getName()),
  );

  for (const entry of ctx.namedTypes.slice(0, MAX_NAMED_TYPE_CANDIDATES)) {
    if (
      !ctx.checker.isTypeAssignableTo(inferredType, entry.type) &&
      !ctx.checker.isTypeAssignableTo(entry.type, inferredType)
    ) {
      // Also allow Partial<T> style: inferred assignable to partial of entry
      continue;
    }

    let score = 0;
    const bidirectional =
      ctx.checker.isTypeAssignableTo(inferredType, entry.type) &&
      ctx.checker.isTypeAssignableTo(entry.type, inferredType);
    if (bidirectional) {
      score += 50;
    } else if (ctx.checker.isTypeAssignableTo(inferredType, entry.type)) {
      score += 20;
    } else {
      score += 10;
    }

    // Exact property set
    if (inferredProps.size > 0 && setsEqual(inferredProps, entry.propertyNames)) {
      score += 40;
    } else if (inferredProps.size > 0) {
      const overlap = [...inferredProps].filter((name) => entry.propertyNames.has(name)).length;
      score += overlap * 3;
      score -= Math.abs(entry.propertyNames.size - inferredProps.size);
    }

    // Prefer same file / module
    if (currentFile && path.normalize(entry.fileName) === path.normalize(currentFile)) {
      score += 25;
    } else if (currentFile && path.dirname(entry.fileName) === path.dirname(currentFile)) {
      score += 10;
    }

    // Prefer shorter names on ties handled below
    score -= entry.name.length * 0.01;

    // Generic wrappers: if structural matches Partial-like
    if (structuralText?.startsWith('{') && entry.propertyNames.size > inferredProps.size) {
      const allInferredInEntry = [...inferredProps].every((name) => entry.propertyNames.has(name));
      if (allInferredInEntry && inferredProps.size > 0) {
        // Candidate for Partial<Name>
        const partialScore = score + 5;
        const partialName = `Partial<${entry.name}>`;
        if (!best || partialScore > best.score) {
          best = { name: partialName, score: partialScore };
        }
      }
    }

    if (!best || score > best.score) {
      best = { name: entry.name, score };
    }
  }

  return best;
}

function findNamedTypeByProperties(
  ctx: InferenceContext,
  structuralText: string,
  currentFile: string,
): { name: string; score: number } | undefined {
  const props = [...structuralText.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(
    (match) => match[1]!,
  );
  if (props.length === 0) {
    return undefined;
  }

  const propSet = new Set(props);
  let best: { name: string; score: number } | undefined;

  for (const entry of ctx.namedTypes) {
    const overlap = props.filter((name) => entry.propertyNames.has(name)).length;
    if (overlap === 0) {
      continue;
    }

    let score = overlap * 5;

    // Exact property set is the strongest signal
    if (setsEqual(propSet, entry.propertyNames)) {
      score += 100;
    } else if (overlap === props.length && entry.propertyNames.size > props.length) {
      // All inferred props exist on a wider type — Partial candidate, weaker than exact
      score += 15;
    } else if (overlap < props.length) {
      // Missing required inferred props — weak
      score -= (props.length - overlap) * 10;
    }

    if (path.normalize(entry.fileName) === path.normalize(currentFile)) {
      score += 25;
    } else if (path.dirname(entry.fileName) === path.dirname(currentFile)) {
      score += 5;
    }

    score -= entry.name.length * 0.01;

    const candidateName = setsEqual(propSet, entry.propertyNames)
      ? entry.name
      : overlap === props.length && entry.propertyNames.size > props.length
        ? `Partial<${entry.name}>`
        : entry.name;

    // Prefer exact names over Partial when scores tie-ish
    const adjusted = candidateName.startsWith('Partial<') ? score : score + 0.5;

    if (!best || adjusted > best.score) {
      best = { name: candidateName, score: adjusted };
    }
  }

  return best;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

function collectNamedTypes(program: ts.Program, checker: ts.TypeChecker): NamedTypeEntry[] {
  const entries: NamedTypeEntry[] = [];
  const seen = new Set<string>();

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }
    if (sourceFile.fileName.includes('node_modules')) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text;
        const key = `${path.normalize(sourceFile.fileName)}::${name}`;
        if (seen.has(key)) {
          return;
        }
        const symbol = checker.getSymbolAtLocation(node.name);
        if (!symbol) {
          return;
        }
        const type = checker.getDeclaredTypeOfSymbol(symbol);
        const propertyNames = new Set(
          checker
            .getApparentType(type)
            .getProperties()
            .map((prop) => prop.getName()),
        );
        seen.add(key);
        entries.push({
          name,
          type,
          symbol,
          fileName: sourceFile.fileName,
          propertyNames,
        });
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return entries;
}

function suggestionFromTypes(
  ctx: InferenceContext,
  types: ts.Type[],
  why: string,
  evidence: string[],
): DraftSuggestion {
  const named =
    types.length === 1
      ? findAssignableNamedType(ctx, types[0]!, ctx.sourceFile.fileName)
      : undefined;

  if (named && types.length === 1) {
    return {
      typeText: named,
      confidence: HIGH_CONFIDENCE,
      why: `${why}; matched named type`,
      evidence: [...evidence, `named ${named}`],
    };
  }

  const typeText = combineTypeTexts(
    types.map((type) => {
      const match = findAssignableNamedType(ctx, type, ctx.sourceFile.fileName);
      return match ?? printType(ctx, type);
    }),
  );

  if (isForbiddenSuggestion(typeText)) {
    return unknownSuggestion(`${why}: printed as any`);
  }

  const confidence =
    types.length === 1 && isConcreteType(types[0]!, ctx.checker)
      ? HIGH_CONFIDENCE
      : MEDIUM_CONFIDENCE;

  return {
    typeText,
    confidence,
    why,
    evidence,
  };
}

function typeFromExpression(
  ctx: InferenceContext,
  expression: ts.Expression,
  why: string,
): DraftSuggestion {
  const unwrapped = unwrapAssertion(expression);
  if (isJsonParseCall(unwrapped) || isJsonParseCall(expression)) {
    return unknownSuggestion('JSON.parse result');
  }

  const type = ctx.checker.getTypeAtLocation(unwrapped);
  if (isUnusableType(type, ctx.checker)) {
    return unknownSuggestion(`${why} type is any/unknown`);
  }

  const named = findAssignableNamedType(ctx, type, ctx.sourceFile.fileName);
  if (named) {
    return {
      typeText: named,
      confidence: HIGH_CONFIDENCE,
      why: `from ${why}; matched named type ${named}`,
      evidence: [`${why} → ${named}`],
    };
  }

  const typeText = printType(ctx, type);
  if (isForbiddenSuggestion(typeText)) {
    return unknownSuggestion(`${why} printed as any`);
  }

  const confidence = isConcreteType(type, ctx.checker) ? HIGH_CONFIDENCE : MEDIUM_CONFIDENCE;
  return {
    typeText,
    confidence,
    why: `from ${why}`,
    evidence: [`${why} → ${typeText}`],
  };
}

function createProgramLanguageService(program: ts.Program): ts.LanguageService {
  const versions = new Map<string, string>();
  const overlays = new Map<string, string>();

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => program.getCompilerOptions(),
    getScriptFileNames: () => program.getRootFileNames().slice(),
    getScriptVersion: (fileName) => versions.get(fileName) ?? '0',
    getScriptSnapshot: (fileName) => {
      if (overlays.has(fileName)) {
        return ts.ScriptSnapshot.fromString(overlays.get(fileName)!);
      }
      const sourceFile = program.getSourceFile(fileName);
      if (sourceFile) {
        return ts.ScriptSnapshot.fromString(sourceFile.getFullText());
      }
      const text = ts.sys.readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => program.getCurrentDirectory?.() ?? process.cwd(),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: (fileName) => overlays.get(fileName) ?? ts.sys.readFile(fileName),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  const service = ts.createLanguageService(host);

  // Attach overlay helpers on the service object for our use
  (
    service as unknown as { __overlays: Map<string, string>; __versions: Map<string, string> }
  ).__overlays = overlays;
  (
    service as unknown as { __overlays: Map<string, string>; __versions: Map<string, string> }
  ).__versions = versions;

  return service;
}

function setOverlay(service: ts.LanguageService, fileName: string, text: string): void {
  const withMeta = service as unknown as {
    __overlays: Map<string, string>;
    __versions: Map<string, string>;
  };
  withMeta.__overlays.set(fileName, text);
  const current = Number(withMeta.__versions.get(fileName) ?? '0');
  withMeta.__versions.set(fileName, String(current + 1));
}

function clearOverlay(service: ts.LanguageService, fileName: string): void {
  const withMeta = service as unknown as {
    __overlays: Map<string, string>;
    __versions: Map<string, string>;
  };
  withMeta.__overlays.delete(fileName);
  const current = Number(withMeta.__versions.get(fileName) ?? '0');
  withMeta.__versions.set(fileName, String(current + 1));
}

function inferImplicitFromLanguageService(
  ctx: InferenceContext,
  finding: Finding,
): DraftSuggestion | undefined {
  if (!ctx.getLanguageService) {
    return undefined;
  }

  const fileName = ctx.sourceFile.fileName;
  const start = finding.nodeStart;
  const end = finding.nodeEnd;

  try {
    const languageService = ctx.getLanguageService();
    const fixes = languageService.getCodeFixesAtPosition(
      fileName,
      start,
      end,
      INFER_FROM_USAGE_ERROR_CODES,
      ts.getDefaultFormatCodeSettings(),
      {},
    );

    const inferred = pickInferredTypeFromFixes(fixes);
    if (inferred) {
      return {
        typeText: inferred,
        confidence: MEDIUM_CONFIDENCE,
        why: 'Language Service inferFromUsage',
        evidence: [`ls inferFromUsage → ${inferred}`],
      };
    }
  } catch {
    // LS may fail on incomplete projects; fall through
  }

  return undefined;
}

function inferExplicitViaStrippedLanguageService(
  ctx: InferenceContext,
  anyNode: ts.Node,
  finding: Finding,
): DraftSuggestion | undefined {
  if (!ctx.getLanguageService) {
    return undefined;
  }

  const declaration = findAnnotatedDeclaration(anyNode);
  if (!declaration || !('type' in declaration) || !declaration.type) {
    return undefined;
  }

  const typeNode = declaration.type as ts.TypeNode;
  if (!typeNodeContains(typeNode, anyNode)) {
    return undefined;
  }

  const sourceText = ctx.sourceFile.getFullText();
  // Strip ": <type>" including colon/whitespace before the type node
  let stripStart = typeNode.getFullStart();
  const before = sourceText.slice(Math.max(0, stripStart - 5), typeNode.getStart(ctx.sourceFile));
  const colonIndex = before.lastIndexOf(':');
  if (colonIndex >= 0) {
    stripStart = Math.max(0, stripStart - 5) + colonIndex;
  }

  const stripEnd = typeNode.getEnd();
  const modified = sourceText.slice(0, stripStart) + sourceText.slice(stripEnd);
  const nameNode = getDeclarationName(declaration);
  if (!nameNode) {
    return undefined;
  }

  // Adjust name position if it was after the stripped region (usually before)
  const nameStart = nameNode.getStart(ctx.sourceFile);
  const adjustedStart = nameStart >= stripEnd ? nameStart - (stripEnd - stripStart) : nameStart;
  const nameEnd = nameNode.getEnd();
  const adjustedEnd = nameEnd >= stripEnd ? nameEnd - (stripEnd - stripStart) : nameEnd;

  const fileName = ctx.sourceFile.fileName;
  let languageService: ts.LanguageService | undefined;

  try {
    languageService = ctx.getLanguageService();
    setOverlay(languageService, fileName, modified);
    const fixes = languageService.getCodeFixesAtPosition(
      fileName,
      adjustedStart,
      adjustedEnd,
      INFER_FROM_USAGE_ERROR_CODES,
      ts.getDefaultFormatCodeSettings(),
      {},
    );
    const inferred = pickInferredTypeFromFixes(fixes);
    if (inferred && !isForbiddenSuggestion(inferred)) {
      return {
        typeText: inferred,
        confidence: MEDIUM_CONFIDENCE,
        why: 'Language Service inferFromUsage (stripped explicit any)',
        evidence: [`ls stripped inferFromUsage → ${inferred}`],
      };
    }
  } catch {
    // ignore LS failures
  } finally {
    if (languageService) {
      clearOverlay(languageService, fileName);
    }
  }

  void finding;
  return undefined;
}

function pickInferredTypeFromFixes(fixes: readonly ts.CodeFixAction[]): string | undefined {
  for (const fix of fixes) {
    if (
      fix.fixName !== 'inferFromUsage' &&
      fix.fixId !== 'inferFromUsage' &&
      !fix.description.toLowerCase().includes('infer')
    ) {
      continue;
    }

    for (const change of fix.changes) {
      for (const textChange of change.textChanges) {
        const text = textChange.newText.trim();
        // Common forms: ": string", ": User", "string"
        const match = text.match(/^:\s*(.+)$/) ?? text.match(/^(.+)$/);
        if (match?.[1]) {
          const typeText = match[1].trim().replace(/;$/, '');
          if (typeText && !isForbiddenSuggestion(typeText)) {
            return typeText;
          }
        }
      }
    }
  }

  // Fallback: any fix that inserts a type annotation
  for (const fix of fixes) {
    for (const change of fix.changes) {
      for (const textChange of change.textChanges) {
        const match = textChange.newText.match(/:\s*([A-Za-z0-9_<>[\]|&\s.,]+)/);
        if (match?.[1]) {
          const typeText = match[1].trim();
          if (typeText && !isForbiddenSuggestion(typeText)) {
            return typeText;
          }
        }
      }
    }
  }

  return undefined;
}

function printType(ctx: InferenceContext, type: ts.Type): string {
  try {
    return ctx.checker.typeToString(
      type,
      undefined,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
    );
  } catch {
    return UNKNOWN_FALLBACK;
  }
}

function isUnusableType(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (!type) {
    return true;
  }
  if (type.flags & ts.TypeFlags.Any) {
    return true;
  }
  if (type.flags & ts.TypeFlags.Unknown) {
    return true;
  }
  // Avoid typeToString when possible — it can Debug-fail on internal error types
  if (type.flags & ts.TypeFlags.Never) {
    return true;
  }
  try {
    const text = checker.typeToString(type);
    return text === 'any' || text === 'error' || text === 'unknown';
  } catch {
    return true;
  }
}

function isConcreteType(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (isUnusableType(type, checker)) {
    return false;
  }
  if (
    type.flags &
    (ts.TypeFlags.String |
      ts.TypeFlags.Number |
      ts.TypeFlags.Boolean |
      ts.TypeFlags.Null |
      ts.TypeFlags.Undefined |
      ts.TypeFlags.Void |
      ts.TypeFlags.BigInt |
      ts.TypeFlags.ESSymbol |
      ts.TypeFlags.NonPrimitive)
  ) {
    return true;
  }
  if (
    type.flags &
    (ts.TypeFlags.StringLiteral |
      ts.TypeFlags.NumberLiteral |
      ts.TypeFlags.BooleanLiteral |
      ts.TypeFlags.EnumLiteral |
      ts.TypeFlags.BigIntLiteral |
      ts.TypeFlags.UniqueESSymbol)
  ) {
    return true;
  }
  if (type.isUnionOrIntersection()) {
    return type.types.every((part) => isConcreteType(part, checker));
  }
  if (type.isClassOrInterface() || type.symbol) {
    return true;
  }
  if (type.flags & ts.TypeFlags.Object) {
    return true;
  }
  return false;
}

function isForbiddenSuggestion(typeText: string): boolean {
  const normalized = typeText.trim();
  return normalized === 'any' || normalized === 'error' || /\bany\b/.test(normalized);
}

function unknownSuggestion(why: string): DraftSuggestion {
  return {
    typeText: UNKNOWN_FALLBACK,
    confidence: LOW_CONFIDENCE,
    why,
    evidence: [why],
    assignable: true,
  };
}

function findAnnotatedDeclaration(anyNode: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = anyNode;
  while (current) {
    if (
      ts.isVariableDeclaration(current) ||
      ts.isParameter(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isPropertySignature(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isMethodSignature(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function typeNodeContains(typeNode: ts.TypeNode, anyNode: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (node === anyNode) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(typeNode);
  return found;
}

function findEnclosingFunction(anyNode: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = anyNode;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function combineTypeTexts(texts: string[]): string {
  const unique = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return UNKNOWN_FALLBACK;
  }
  if (unique.length === 1) {
    return unique[0]!;
  }
  return unique.join(' | ');
}

function collectReturnExpressions(body: ts.ConciseBody): ts.Expression[] {
  if (!ts.isBlock(body)) {
    return [body];
  }

  const expressions: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== body.parent) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      expressions.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return expressions;
}

function getDeclarationName(declaration: ts.Node): ts.Identifier | undefined {
  if (
    (ts.isVariableDeclaration(declaration) ||
      ts.isParameter(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertySignature(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isFunctionDeclaration(declaration)) &&
    declaration.name &&
    ts.isIdentifier(declaration.name)
  ) {
    return declaration.name;
  }
  return undefined;
}

function findIdentifierReferences(ctx: InferenceContext, symbol: ts.Symbol): ts.Identifier[] {
  const references: ts.Identifier[] = [];
  const target = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!target) {
    return references;
  }

  for (const sourceFile of ctx.program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || sourceFile.fileName.includes('node_modules')) {
      continue;
    }

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const candidate = ctx.checker.getSymbolAtLocation(node);
        if (candidate && (candidate === symbol || candidate.declarations?.[0] === target)) {
          if (node !== (target as ts.NamedDeclaration).name) {
            references.push(node);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return references;
}

function isJsonParseCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) {
    return false;
  }
  const callee = expression.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'JSON' &&
    callee.name.text === 'parse'
  );
}

function unwrapAssertion(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}

function looksLikeJsonParse(expression: ts.Expression | undefined): boolean {
  return !!expression && isJsonParseCall(expression);
}

function isArithmeticOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AsteriskToken ||
    kind === ts.SyntaxKind.SlashToken ||
    kind === ts.SyntaxKind.PercentToken ||
    kind === ts.SyntaxKind.MinusToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskToken
  );
}

function resolveAbsolute(file: string, rootDir: string): string {
  return path.normalize(path.resolve(rootDir, file));
}

function parseTypeViaTemp(ctx: InferenceContext, typeText: string): ts.Type | undefined {
  for (const entry of ctx.namedTypes) {
    const printed = printType(ctx, entry.type);
    if (printed === typeText) {
      return entry.type;
    }
  }

  if (typeText.startsWith('{')) {
    return createSyntheticObjectType(ctx, typeText);
  }

  return undefined;
}

function createSyntheticObjectType(ctx: InferenceContext, typeText: string): ts.Type | undefined {
  const props = [...typeText.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((match) => match[1]!);
  if (props.length === 0) {
    return undefined;
  }

  for (const entry of ctx.namedTypes) {
    if (props.every((prop) => entry.propertyNames.has(prop))) {
      return entry.type;
    }
  }

  return undefined;
}

/**
 * Verify a candidate type string is assignable at identifier use sites
 * by parsing it against the checker where possible.
 */
export function verifyAssignableAtSites(
  ctx: { checker: ts.TypeChecker; namedTypes: NamedTypeEntry[] },
  typeText: string,
  sites: ts.Expression[],
): boolean {
  const resolved = parseTypeViaTemp(ctx as InferenceContext, typeText);
  if (!resolved) {
    return true;
  }

  for (const site of sites) {
    const siteType = ctx.checker.getTypeAtLocation(site);
    if (isUnusableType(siteType, ctx.checker)) {
      continue;
    }
    if (
      !ctx.checker.isTypeAssignableTo(resolved, siteType) &&
      !ctx.checker.isTypeAssignableTo(siteType, resolved)
    ) {
      // For argument positions, resolved should be assignable TO expected
      // Heuristic: if neither direction works, fail
      return false;
    }
  }

  return true;
}
