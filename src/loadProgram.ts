import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface LoadedProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  tsconfigPath: string;
  rootDir: string;
  configFileNames: string[];
}

const NODE_MODULES_SEGMENT = `${path.sep}node_modules${path.sep}`;

export type LoadProgress = (message: string) => void;

/**
 * Load one or more TypeScript programs from tsconfig (including project references).
 */
export function loadPrograms(
  cwd: string,
  tsconfigPath?: string,
  onProgress?: LoadProgress,
): LoadedProgram[] {
  onProgress?.('Loading tsconfig…');
  const resolvedConfig = resolveTsconfig(cwd, tsconfigPath);
  onProgress?.(`Loaded ${path.basename(resolvedConfig)}`);

  const loaded: LoadedProgram[] = [];
  const visited = new Set<string>();

  collectPrograms(resolvedConfig, loaded, visited, onProgress);
  return loaded;
}

export function loadProgram(
  cwd: string,
  tsconfigPath?: string,
  onProgress?: LoadProgress,
): LoadedProgram {
  const programs = loadPrograms(cwd, tsconfigPath, onProgress);
  if (programs.length === 0) {
    throw new Error('Failed to create TypeScript program');
  }
  return programs[0]!;
}

function resolveTsconfig(cwd: string, tsconfigPath?: string): string {
  if (tsconfigPath) {
    const absolute = path.resolve(cwd, tsconfigPath);
    if (!fs.existsSync(absolute)) {
      throw new Error(`tsconfig not found: ${absolute}`);
    }
    return absolute;
  }

  const found = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json');
  if (!found) {
    throw new Error(`No tsconfig.json found from ${cwd}`);
  }
  return path.resolve(found);
}

function collectPrograms(
  configPath: string,
  out: LoadedProgram[],
  visited: Set<string>,
  onProgress?: LoadProgress,
): void {
  const normalized = path.normalize(configPath);
  if (visited.has(normalized)) {
    return;
  }
  visited.add(normalized);

  const configFile = ts.readConfigFile(normalized, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `Failed to read ${normalized}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`,
    );
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(normalized),
    undefined,
    normalized,
  );

  const references = [...(parsed.projectReferences ?? [])];
  for (const reference of references) {
    const refPath = ts.resolveProjectReferencePath(reference);
    if (refPath) {
      collectPrograms(refPath, out, visited, onProgress);
    }
  }

  onProgress?.('Creating TypeScript program…');
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });

  out.push({
    program,
    checker: program.getTypeChecker(),
    tsconfigPath: normalized,
    rootDir: path.dirname(normalized),
    configFileNames: parsed.fileNames,
  });
}

export function getAnalyzableSourceFiles(program: ts.Program): ts.SourceFile[] {
  return program
    .getSourceFiles()
    .filter((sourceFile) => isAnalyzableSourceFile(sourceFile, program));
}

export function isAnalyzableSourceFile(sourceFile: ts.SourceFile, program: ts.Program): boolean {
  if (sourceFile.isDeclarationFile) {
    return false;
  }

  const fileName = sourceFile.fileName;
  if (fileName.includes(NODE_MODULES_SEGMENT) || fileName.includes('/node_modules/')) {
    return false;
  }

  const rootFileNames = new Set(program.getRootFileNames().map((name) => path.normalize(name)));
  return rootFileNames.has(path.normalize(fileName));
}
