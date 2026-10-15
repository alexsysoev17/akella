# AKELLA Motion Agent benchmark

The architecture source of truth remains `docs/architecture-handoff.md`. This document describes commands and evaluation limits.

## Modes and commands

Run from the platform root. Dependencies are already managed by the existing npm project. If Node/npm are missing from terminal PATH on this Mac, use the existing `sh scripts/platform.sh` wrapper; it uses the installed bundled runtime.

```sh
npm run benchmark:quick
npm run benchmark
npm run benchmark:video
npm run benchmark:report -- --input artifacts/harness/REPORT.json
npm run benchmark:replay -- --project projects/test11 --run 9edb92d1-e9bc-47bf-ae87-ba634ac99a0a
```

Equivalent portable local wrapper examples:

```sh
sh scripts/platform.sh benchmark --cases NEW_09_COMPOUND,NEW_10_GROUP,WORKFLOW_04_EIGHT_OBJECTS
sh scripts/platform.sh benchmark
sh scripts/platform.sh benchmark --video --cases WORKFLOW_04_EIGHT_OBJECTS,WORKFLOW_05_PATH_SEQUENCE
sh scripts/platform.sh benchmark-report --input artifacts/harness/REPORT.json
sh scripts/platform.sh benchmark-replay --project projects/test11 --run 9edb92d1-e9bc-47bf-ae87-ba634ac99a0a
```

Full deterministic mode invokes the registered reference provider, the real adapter/parser/planner/normalizer/compiler/executor, real local Chromium QA and filesystem persistence on disposable artificial Figma-export projects. It does not call a live LLM. The dataset includes new animations, compound/group actions, timing, inheritance, edits, contextual follow-ups, a multi-turn workflow, recent-four versus all-six selection, invalid dependencies/enum/provenance/identity, and unsupported capabilities.

`--video` explicitly exports MP4 and compares selected decoded H264 frames against Chromium Preview. Ordinary animation requests and default benchmark mode do not export full video. Pixel comparison checks sampled technical consistency, not artistic quality or equivalence to Figma PNG previews.

Saved-run replay copies the requested project into a temporary directory, loads the stored first provider response and executes it with one reference adapter call. The original project is untouched. It is a historical-output replay, not a new semantic model test; it requires local saved artifacts and is not embedded client data in this repository.

Optional live mode:

```sh
npm run benchmark:live -- --cases NEW_09_COMPOUND
# Or:
sh scripts/platform.sh benchmark --live --provider codex-sdk --cases WORKFLOW_04_EIGHT_OBJECTS
```

Live mode transmits the selected artificial fixture's prompt/context to the configured external provider. It is opt-in, has one provider call per user turn and no automatic repair in this first-pass benchmark. Never run dozens of live cases automatically after an ordinary code change. Existing SDK authentication and budgets apply. A live case passing is not proof of arbitrary language reliability.

## Artifacts and comparison

Default results: `artifacts/harness/benchmark/<git-commit>/<timestamp>.json` plus HTML. Artifacts, rendered video, screenshots and user projects are ignored by Git. Reports include dataset digest, provider/model/mode, Git commit, clean/dirty status, component code versions, per-case checks/stages, actual Run metrics and explicit NOT_TESTED fields. Dirty-tree results must not be attributed solely to the recorded commit.

```sh
sh scripts/platform.sh benchmark --baseline artifacts/harness/PREVIOUS.json --output artifacts/harness/CURRENT.json
```

Regression comparison requires the same dataset digest, provider/model and mode. A changed dataset is NOT COMPARABLE. The initial exploratory 30-case run had fixture/transport defects; it is not a controlled application baseline. Future releases can compare frozen datasets across commits. Benchmark results are never silently promoted into production configuration.

Task completion, safe expected rejection, semantic interpretation, compilation completeness, execution/persistence and visual technical QA have distinct measures. Reference fixtures do not measure model semantic accuracy: that rate is null/NOT_TESTED. QA WARNING is displayed separately from PASSED. Numerical amplitude/frequency changes are checked against actual prior expressions; unrelated tracks remain unchanged. Unknown token usage/cost is null, not zero. Local reference latency is not live-provider latency. Artistic QA is NOT_TESTED.

The benchmark deliberately reuses `harness/evals.ts`, `executeMotion`, `compileRequirement`, the existing registry, engine, renderer, QA and transaction/Undo history. It does not create another agent or compiler. Unit regressions under `tests/semantic-graph.test.ts` additionally verify source spans, whitespace-only recovery, stable expansion IDs, cycles, scoped structural repair, the exact eight-object case, same-target independent clauses and FPS conversion. Full `npm test` retains the existing engine, rendering, Preview/MP4, legacy-project and Undo/Redo regressions.

Dataset update2026-10-14:46 scenarios, including7 lifecycle regressions (animation delete, direction edit, expression delete, dependent timing and create→reverse→remove). `LIFECYCLE_*` run through the same production execution path and local render QA. Use `--cases` for focused checks; reference outputs still do not measure live semantic accuracy.

Dataset update 2026-10-15: **50 scenarios**. Four temporal cases cover existing-track scheduling, cross-effect Fade-after-Position, missing-anchor safe rejection and an eight-step create/reverse/schedule/duration/delete/recreate/reconnect/Undo workflow. Undo uses the real editor history API; it is not a claimed natural-language Undo test. Dedicated unit tests add 32 seeded dependency metamorphisms. Use `benchmark-replay ... --recorded-state` to require a unique authoritative full history state matching a recorded scoped projection. A scoped prompt is not a complete historical snapshot. Final reference-provider report: `artifacts/harness/temporal-final-50.json`; live semantic accuracy remains NOT TESTED.

Text update2026-10-15: **55 scenarios**. TEXT_01–04 exercise block/line/word/grapheme Slide+Fade through one compact instruction; TEXT_05_EDIT_AND_BLOCK tests creation→speed-up→return to block using existing tracks. Dataset `2026-10-15.text-animation.1`. Results: `artifacts/harness/text-final-55.json`; reference-provider semantic accuracy remains NOT TESTED. Actual text video parity and Unicode/layout tests live in `tests/text-animation.test.ts`, not in a claimed live-model benchmark. Unsupported independent ligature shaping remains explicit.

Quality update2026-10-15: **56 scenarios**, dataset `2026-10-15.text-quality.1`. TEXT_06_LINE_INERTIA_QUALITY intentionally supplies staggered/0 from a reference semantic output and checks positive resolved rhythm, both base effects, one source-attached expression and actual renderer QA. Negative legacy SVG baseline-snapping and positive alpha-centroid transport are in `tests/text-animation.test.ts`. Full report: `artifacts/harness/text-quality-full-56.json`. Separate saved Run86608df3 replay and actual client-font frame/video ablations remain local artifacts, not committed client fixtures or live-model tests.
