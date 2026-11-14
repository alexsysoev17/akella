# Reviewed creative knowledge

This is the operating method for the implemented banner and motion reference stores. See `architecture-handoff.md` for the current runtime contracts and verification status. Source code remains authoritative.

## Evidence before a rule

Keep three distinct things: an explicit brand instruction, an observation about one example, and an interpretation that still needs checking. Record the source file/page/node or video SHA and time interval, scope, review status and limits. A successful example is evidence for that task, not a universal layout or timing preset. An accepted film can still contain a defect that the current brief forbids.

For Figma, inspect the editable hierarchy and actual exported pixels together. Capture the real font face/weight, line breaks, visible glyph bounds, tracking, leading, object transforms, background paints and material layers. Check the logo artwork and its actual clearance diagram separately. A screenshot alone does not tell us which elements are editable text, baked artwork, or a diagram annotation.

Classify a complete advertisement, isolated KV, construction diagram, negative example and interface screenshot separately. A section label is useful context but does not make all its children interchangeable. Link genuine resize siblings within a campaign; similar dimensions alone are insufficient. Keep source materials distinct from an entire finished-banner screenshot. Product identity and claims must match the new brief before reusing source KV.

For video, start with metadata, SHA and an overview of the whole clip, then inspect dense ordered frames around entrance, pose handoff, text replacement and settling. Preserve the actual timestamps. Record what is visible: direction, overlap of actions, persistence, reading interval and relative emphasis. Do not claim the original easing function, velocity or a large overshoot from a few raster frames. A one-pixel contour difference can be rasterization; use an explicit uncertainty note. Review real-speed playback when making a judgment about perceived rhythm; a contact sheet alone cannot prove it.

`scripts/knowledge/collect_motion_references.py` provides repeatable collection for a new source directory. It preserves original files, verifies their hashes before/after extraction, keeps selected original frame PTS/time-base and produces overview/dense sheets with hashes. An explicit JSON window list selects intervals for closer review. Output must be outside the source directory and a new directory; previous collections are never overwritten. Every collected record is `NOT_REVIEWED`, with no inferred patterns or approval. The reviewed runtime manifest remains a separate deliberate curation step.

## Storage and retrieval

Banner data uses the existing reviewed portable bundle and atomic snapshot importer. Exact source evidence and resource hashes remain in the stored record; search uses text plus reviewed visual descriptions. The current dense index is not a pixel embedding model. Mandatory brand identity/editorial rules accompany retrieved examples. Select examples for their communication structure and then choose a suitable format within their family. Pin the exact evidence and resources in each project revision.

The current accepted-motion corpus is small enough for bounded local scenario/content retrieval. It stores observations and reusable patterns with original-source hashes and timecodes, plus verified derived contact sheets. Matching format is a tie-breaker, not permission to copy unrelated brand artwork. The planner may see up to two relevant temporal sheets once; executors receive concise notes. Missing reference data must not turn into a creative refusal. A larger future corpus may justify semantic/video retrieval, but that is not implemented or claimed here.

New brands need their own source/profile and reviewed examples. Do not transfer X5 logo ratios, palette, typography or campaign conditions to another brand. General composition and motion principles remain advisory and subordinate to the brief and actual source.

## Authoring and comparison

Before assembling a banner, state the real primary message, reading order and semantic use of the selected example. A benefit, purchase condition and campaign-mechanic label are different roles even when all are text. Use actual marks/fonts and original materials where appropriate. Krea creates a missing individual asset; the banner remains an editable local composition.

A resize keeps content and resource identities, then recomposes scale and placement. It is not a new campaign. Check both the result and the unchanged originals, including exact copy, fonts, images and layer identities.

Before animating, read the whole storyboard as a sequence. Distinguish cumulative build, shared-object transformation, message replacement and a new shot. Infer nearby/cropped entry edges from source geometry, then confirm against visible artwork. Join approach and settling as a continuous whole-pose trajectory using the existing inertia tools; inspect translation, scale and rotation together. Keep wiggle separate from inertia. When shortening a hold or moving a beat, inspect every linked element of that beat: the main object, its surrounding products/badges, source-state transitions and attached effects. Moving the hero alone can leave the supporting ensemble on its old schedule; preserve an intentional stagger rather than accidentally introducing a second catch-up motion. Text handoff is judged from visible glyph clearance, not merely overlapping boxes. Check each incoming line against moving foreground silhouettes: a later line being occupied does not justify delaying an already clear first line. Likewise, a changed text container size does not prove changed visible lettering; only native shaping and ink evidence can justify treating different boxes as the same text pose.

Separate technical verification from visual judgment. Technical checks protect source integrity, contracts, deterministic rendering and measurable requested constraints. Creative review compares the actual output with relevant references and the brief: typography, hierarchy, spacing, material depth, movement logic and rhythm. A passing schema or model self-review is not approval. Preserve evidence of both improvements and remaining weaknesses; avoid a universal numerical beauty gate or endlessly accumulating restrictions for each example.

Measure retrieval/context/provider cost separately. Report actual input/output/cache usage when available, and mark missing timeout usage unknown. A smaller serialized context is not by itself a proven token or price saving. Keep the current reference evidence available while compacting stale observations, and retain the complete trace for diagnosis.
