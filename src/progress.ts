import { formatCoveragePercent } from './coverage.js';
import type { Finding, TypeCoverage } from './types.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const SPINNER_INTERVAL_MS = 80;
const CLEAR_LINE = '\r\x1b[K';

export interface ProgressReporter {
  phase(message: string): void;
  done(message?: string): void;
  fail(message: string): void;
}

export interface CreateProgressOptions {
  stream?: NodeJS.WritableStream;
  /** Override TTY detection (tests). */
  isTTY?: boolean;
  /** When false, all methods are no-ops. */
  enabled?: boolean;
}

/**
 * Lightweight stderr progress: spinner on TTY, plain phase lines in CI/non-TTY.
 */
export function createProgress(options: CreateProgressOptions = {}): ProgressReporter {
  if (options.enabled === false) {
    return silentProgress();
  }

  const stream = options.stream ?? process.stderr;
  const isTTY =
    options.isTTY ??
    (typeof (stream as NodeJS.WriteStream).isTTY === 'boolean'
      ? !!(stream as NodeJS.WriteStream).isTTY
      : false);
  const useSpinner = isTTY && !process.env.CI;

  if (useSpinner) {
    return createSpinnerProgress(stream);
  }
  return createLineProgress(stream);
}

export function formatMachineDoneSummary(findings: Finding[], coverage?: TypeCoverage): string {
  const total = findings.length;
  const findingLabel = `${total} finding${total === 1 ? '' : 's'}`;
  if (!coverage) {
    return `Done — ${findingLabel}`;
  }
  return `Done — ${findingLabel} · coverage ${formatCoveragePercent(coverage)}`;
}

function silentProgress(): ProgressReporter {
  return {
    phase() {},
    done() {},
    fail() {},
  };
}

function createLineProgress(stream: NodeJS.WritableStream): ProgressReporter {
  return {
    phase(message: string): void {
      stream.write(`anynot: ${message}\n`);
    },
    done(message?: string): void {
      if (message) {
        stream.write(`anynot: ${message}\n`);
      }
    },
    fail(message: string): void {
      stream.write(`anynot: ${message}\n`);
    },
  };
}

function createSpinnerProgress(stream: NodeJS.WritableStream): ProgressReporter {
  let frameIndex = 0;
  let currentMessage = '';
  let timer: ReturnType<typeof setInterval> | undefined;
  let active = false;

  const paint = (): void => {
    if (!active) {
      return;
    }
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? '⠋';
    frameIndex += 1;
    stream.write(`${CLEAR_LINE}${frame} ${currentMessage}`);
  };

  const start = (message: string): void => {
    currentMessage = message;
    active = true;
    if (!timer) {
      paint();
      timer = setInterval(paint, SPINNER_INTERVAL_MS);
      if (typeof timer === 'object' && 'unref' in timer) {
        timer.unref();
      }
    } else {
      paint();
    }
  };

  const stop = (): void => {
    active = false;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    stream.write(CLEAR_LINE);
  };

  return {
    phase(message: string): void {
      start(message);
    },
    done(message?: string): void {
      stop();
      if (message) {
        stream.write(`✔ ${message}\n`);
      }
    },
    fail(message: string): void {
      stop();
      stream.write(`✖ ${message}\n`);
    },
  };
}
