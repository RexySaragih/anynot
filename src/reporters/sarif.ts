import type { Finding } from '../types.js';

const SARIF_VERSION = '2.1.0';
const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const TOOL_NAME = 'anynot';
const RULE_ID = 'explicit-any';

/**
 * Emit SARIF 2.1.0 for GitHub code scanning (and other SARIF consumers).
 */
export function reportSarif(
  findings: Finding[],
  stream: NodeJS.WritableStream = process.stdout,
): void {
  stream.write(`${JSON.stringify(toSarif(findings), null, 2)}\n`);
}

export function toSarif(findings: Finding[]): SarifLog {
  const rules = [
    {
      id: RULE_ID,
      name: 'ExplicitAny',
      shortDescription: { text: 'Explicit or JSDoc any usage' },
      fullDescription: {
        text: 'Finds TypeScript any annotations and suggests safer replacement types.',
      },
      defaultConfiguration: { level: 'error' as const },
      helpUri: 'https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#any',
    },
  ];

  const results = findings.map((finding) => toSarifResult(finding));

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            rules,
          },
        },
        results,
      },
    ],
  };
}

function toSarifResult(finding: Finding): SarifResult {
  const suggestion = finding.suggestion
    ? ` suggested: ${finding.suggestion.typeText} (${finding.suggestion.confidence})`
    : '';
  const message = `${finding.kind} any${suggestion}`.trim();

  return {
    ruleId: RULE_ID,
    level: 'error',
    message: { text: message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: toSarifUri(finding.file) },
          region: {
            startLine: finding.line,
            startColumn: finding.column,
          },
        },
      },
    ],
    properties: {
      findingId: finding.id,
      kind: finding.kind,
      confidence: finding.suggestion?.confidence,
      fixable: finding.fixable ?? false,
    },
  };
}

function toSarifUri(file: string): string {
  return file.split('\\').join('/');
}

export interface SarifLog {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

interface SarifRun {
  tool: {
    driver: {
      name: string;
      informationUri?: string;
      rules: Array<{
        id: string;
        name: string;
        shortDescription: { text: string };
        fullDescription?: { text: string };
        defaultConfiguration?: { level: 'error' | 'warning' | 'note' };
        helpUri?: string;
      }>;
    };
  };
  results: SarifResult[];
}

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: {
        startLine: number;
        startColumn: number;
      };
    };
  }>;
  properties?: Record<string, unknown>;
}
