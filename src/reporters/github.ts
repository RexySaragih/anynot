import type { Finding } from '../types.js';

/**
 * Emit GitHub Actions workflow annotations (::error / ::warning).
 * See https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions
 */
export function reportGithub(
  findings: Finding[],
  stream: NodeJS.WritableStream = process.stdout,
): void {
  for (const finding of findings) {
    stream.write(`${formatGithubAnnotation(finding)}\n`);
  }

  if (findings.length > 0) {
    stream.write(`::notice::anynot found ${findings.length} any usage(s)\n`);
  }
}

export function formatGithubAnnotation(finding: Finding): string {
  const level = finding.suggestion?.confidence === 'high' ? 'warning' : 'error';
  const file = escapeProperty(finding.file);
  const title = escapeProperty(`anynot:${finding.kind}`);
  const message = escapeMessage(buildMessage(finding));

  return `::${level} file=${file},line=${finding.line},col=${finding.column},title=${title}::${message}`;
}

function buildMessage(finding: Finding): string {
  const parts = [`${finding.kind} any`];
  if (finding.suggestion) {
    parts.push(`suggested ${finding.suggestion.typeText} (${finding.suggestion.confidence})`);
  }
  if (finding.snippet) {
    parts.push(finding.snippet);
  }
  return parts.join(' — ');
}

/** Escape values used in GitHub Actions command properties. */
function escapeProperty(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

/** Escape the message body after `::`. */
function escapeMessage(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
