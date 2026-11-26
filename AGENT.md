# Agent guide

Guidance for AI coding agents working in this repo. Prefer reading this and `ARCHITECTURE.md` before inventing new surface area.

## Repo facts

- ESM TypeScript package (`"type": "module"`); imports use `.js` extensions in source
- CLI entry: `src/cli.ts` → bin `anynot` → `dist/cli.js`
- Public library surface: `src/index.ts` (re-export only what consumers need)
- Build: `tsc -p tsconfig.build.json` → `dist/`
- Tests: Vitest, `test/**/*.test.ts`, fixtures in `test/fixtures/`
- Peer: `typescript` >= 5; runtime dep: `cac` only
- Node >= 18

## Where to change what

| Goal                                                | Touch                                                       |
| --------------------------------------------------- | ----------------------------------------------------------- |
| New CLI flag / exit behavior                        | `cli.ts` (+ test via `runAnynot`)                           |
| Progress / spinner / stderr status                  | `progress.ts` (+ hooks from `analyze` / `cli`)              |
| Detection of `any` / kinds / JSDoc / implicit codes | `findAny.ts`, `ignore.ts`                                   |
| Suggestion quality / confidence / dual safe         | `inferType.ts`, constants in `types.ts`                     |
| What `--fix` rewrites                               | `inferType.ts` (`fixable`) + `fix.ts` (`isFixable`, ranges) |
| Human/JSON report shape                             | `report.ts`                                                 |
| SARIF / GitHub output                               | `reporters/*`                                               |
| Report file output (`--out`)                        | `cli.ts` (`openReportStream` / `emitReport`)                |
| Baseline format                                     | `baseline.ts`                                               |
| Coverage metric                                     | `coverage.ts`                                               |
| Shared types                                        | `types.ts` then update exporters in `index.ts`              |
| Program / tsconfig loading                          | `loadProgram.ts`                                            |

Do not add new top-level `.md` files unless the user asks. Do not add dependencies without a clear need (globs are intentionally hand-rolled).

## Conventions

- No `any` in this codebase’s own types when avoidable; this tool’s purpose is removing `any`
- Prefer small focused modules over new abstraction layers
- Named constants for magic numbers/strings (`types.ts`, ignore directives, diagnostic codes)
- Guard clauses over deep nesting
- Export new APIs from `index.ts` only when library users need them
- Keep CLI orchestration thin; business logic stays in analyze/find/infer/fix/report
- Machine formats (`--json`, SARIF, GitHub) must stay pure on their report stream; progress always goes to stderr
- `--out` must write the selected report format to disk and leave stdout empty (confirm on stderr)

## Finding IDs and baselines

Finding `id` = first 12 hex chars of `sha1(\`${file}:${line}:${column}:${kind}\`)`.

Changing id inputs (relative path format, kind names, line/column 1-based rules) **breaks baselines and ignore-by-id**. Treat as a breaking change; update tests and document migration if you must change it.

## Fix safety rules (do not loosen casually)

`--fix` may apply a suggestion only when all hold:

- `confidence === 'high'`
- `assignable !== false`
- not `implicit`
- suggestion text is non-empty and does not contain `any`

Safe suggestion (`unknown`) is for humans/review, not for autofix when best is speculative.

## Test style

Behavioral tests (behavior name → when… → should…), Given/When/Then comments welcome.

```ts
describe('Find explicit any', () => {
  describe('when a sample project contains every explicit any form', () => {
    it('should report every explicit any location', () => {
      // Given / When / Then against analyze({ cwd: fixture })
    });
  });
});
```

- Prefer `analyze({ cwd: fixtureDir, include: [...] })` over mocking checker internals
- Use `skipInference: true` when the behavior under test is detection-only
- For CLI/baseline/reporters, call `runAnynot` or reporter functions; use temp dirs for write paths
- Mock I/O boundaries (filesystem temp, stdout capture), not `inferType` / `findAny` internals
- Add fixtures under `test/fixtures/<wave-or-topic>/` with a minimal `tsconfig.json` when needed

Run: `npm test`. Build: `npm run build`.

## Do

- Match existing patterns in the module you edit
- Extend kinds / reporters / flags with tests that fail first on fixtures
- Keep docs (`README` / `PRODUCT` / `ARCHITECTURE` / `AGENT`) accurate when behavior changes
- Mark unshipped ideas as future — do not implement “while you’re here” product expansion

## Don’t

- Invent CLI flags, config file formats, or reporters that are not requested
- Auto-fix implicit any or medium/low confidence suggestions
- Suggest or write `any` as a replacement type
- Add heavy deps (minimatch, commander, etc.) without strong justification
- Create one test file per production file; name tests after behaviors
- Change product code “for docs” unless fixing a factual bug required for accuracy
- Commit or publish unless the user asks

## Quick verification checklist

After a change:

1. `npm test`
2. `npm run build` if exports/`cli`/`types` changed
3. Mentally walk detect → infer → fix → report for regressions
4. Update the relevant root `.md` if user-facing behavior changed
