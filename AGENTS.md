# Architecture Documentation Policy

The canonical architecture handoff is `docs/architecture-handoff.md`; source code remains the technical source of truth.

Before a substantial change, read the relevant sections. After changes affecting architecture, runtime behavior, data contracts, rendering, agent execution, provider integration, tracing, storage, validation, or repair, update only the affected sections before completing the task. Documentation updates are part of the definition of done.

Describe verified implementation, not intentions. Keep diagrams, exact file paths, interfaces, execution flows, limits, and known issues consistent with the code. Preserve the distinction between implemented, partial, unused, and not implemented components, and between confirmed bugs and hypotheses. Mark unverified areas `NOT VERIFIED` or `REQUIRES REVIEW`.

Maintain Document Status: actual update date, last full audit date, Git branch/commit and working-tree state when available, documentation version, and update scope. Do not label a partial update as a full audit or attribute uncommitted code to a commit. Add a brief Architecture Change History entry for significant changes with affected contracts and actual verification results.

Use incremental updates, not a new handoff-v2 document, full re-audit after every small edit, or a background watcher. Do not claim tests passed unless run; distinguish mocks, historical artifacts, live-provider tests, and unperformed checks. Never include credentials or secrets.

# Local Git Checkpoint Policy

Before substantial changes, inspect `git status` and the relevant diff. For major architectural work, create a clearly named local checkpoint commit containing only reviewed source/configuration/tests/documentation. The user authorizes local checkpoints; never push or configure a remote without explicit authorization.

Stage reviewed paths explicitly. Never include secrets, user projects, client assets, Figma exports, diagnostic screenshots/videos/logs, dependencies or generated builds. Check the staged diff before committing. Keep unrelated user edits intact and do not silently incorporate them into a checkpoint.

Do not use destructive reset/clean, force checkout, history rewriting, or overwrite uncommitted user changes. Prefer inspecting an older commit in isolation or making a new corrective/revert commit after reviewing impact and preserving current edits. Git protects tracked application files, not ignored client/project data; explain that boundary when restoring versions.
