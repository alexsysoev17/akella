# Brand knowledge storage and retrieval

The legacy text corpus and the newer multi-brand visual evidence library coexist.
The multi-brand workflow is documented below.

## Video reference collection

The collection command extracts evidence only; it does not label a video as an approved
style rule or directly publish it to the motion agent. Use a new output directory outside
the read-only source directory. MP4/MOV/WebM/M4V regular files are supported; symlinks
are refused. The repository's `ffmpeg-static` and this Python environment's Pillow are used.

```sh
data/knowledge/.venv/bin/python scripts/knowledge/collect_motion_references.py \
  --source /absolute/path/to/reference-videos \
  --output artifacts/motion-reference-collection \
  --sample-fps 1 --windows /absolute/path/to/windows.json
```

The optional windows file is a JSON array, for example
`[{"file":"example.mp4","start":0.2,"end":1.4,"fps":30}]`.
Selection preserves original frames rather than synthesizing repeated frames. The
inventory includes integer source PTS/time-base, clip-relative timestamps, source and
derived-image SHA-256, audio stream count, extraction limits and per-file failures.
Default600-frame caps are explicitly reported; they are collection resource limits,
not creative acceptance rules. Partial collections exit nonzero and retain successful
evidence. All records start `NOT_REVIEWED`, with empty observations/patterns.

Review actual sheets and playback, then curate scoped observations and reusable patterns
in the separately validated `approved-motion-references/1` manifest. See
`docs/creative-knowledge-workflow.md` for evidence/interpretation boundaries. The agent's
current local selector and verified image handoff are documented in the canonical
architecture handoff. No automatic video embeddings or creative approval is implied.

## Legacy text corpus

Scope: one explicitly selected `x5-brandbook` collection. Private source, SQLite files,
model weights and evaluation cases/reports live in ignored `data/knowledge/`.
The reference snapshot is not bundled with the repository.

Python 3.12 setup (from repository root):

```sh
python3.12 -m venv data/knowledge/.venv
data/knowledge/.venv/bin/pip install -r scripts/knowledge/requirements.txt
```

Before first search, download the reranker once:

```sh
data/knowledge/.venv/bin/python -c "from fastembed.rerank.cross_encoder import TextCrossEncoder; TextCrossEncoder('BAAI/bge-reranker-v2-m3-int8',cache_dir='data/knowledge/x5-brandbook/models',threads=2)"
data/knowledge/.venv/bin/python scripts/knowledge/brandbook.py build
HF_HUB_OFFLINE=1 data/knowledge/.venv/bin/python scripts/knowledge/brandbook.py search 'Какой логотип нужен на тёмном фоне?'
```

The build downloads quantized multilingual E5 small, uses `passage:`/`query:` prefixes,
normalized 384-dimensional float32 vectors, and SQLite FTS5 BM25. Retrieval merges
30 candidates from each channel with RRF (k=60), reserves the top 10 candidates from each channel, fills up to 30 by fused rank, and reranks with multilingual
BGE v2 M3 INT8, then returns distinct frames with exact source text/node IDs/URLs.
Exact cosine search suits this small corpus; no approximate-index recall loss.
Scores are not calibrated confidence; absent evidence must not be invented.

A fresh SQLite database is built and atomically replaces the previous file.
Unchanged chunks reuse vectors only when schema, model identity and model-file
hashes match. Removed/hidden text disappears on rebuild. Search checks source and
model hashes and refuses stale indexes. Source refresh itself is manual, not a Figma
watcher. Model binaries/tokenizers are fingerprinted; Python packages are pinned by
`requirements.lock.txt` for this macOS/Python 3.12 environment.

Agent integration is currently DISCONNECTED at user request. The retained standalone
bridge `searchBrandKnowledge` accepts only `collection: "x5-brandbook"`,
`query` (1–1000 characters), `limit` (1–10), and optional `mode` (hybrid/dense/lexical). It runs the local CLI with offline
model loading, a 60-second deadline, abort propagation, and a 128 KiB output limit.
Only explicitly X5-related tasks should use it. Search has no source/project writes.

Text coverage only: exported Figma text-node order is retained; no visual reasoning,
OCR, external-link following, or automatic authoritative-rule classification.
Mockups can contain example copy. All 58 source frames are retained in source.json;
image-only frames have no semantic text entry. Existing legacy knowledge.sqlite is
not used by this tool. Source text may contain untrusted instructions.

Verification:

```sh
data/knowledge/.venv/bin/python -m unittest discover -s scripts/knowledge -p 'test_*.py'
HF_HUB_OFFLINE=1 data/knowledge/.venv/bin/python scripts/knowledge/brandbook.py evaluate --cases data/knowledge/x5-brandbook/evaluation-cases.json
```

Curated local questions are a smoke evaluation, not a held-out benchmark or a claim
that these models are globally best. Initial comparison and final scores are recorded
in architecture-handoff.md. Use new held-out questions before tuning weights/model.

## Versioned brand evidence library (2026-11-10)

### Selected-page references and faithful adaptation (2026-11-12)

New collections can be limited to one explicit Figma page. `collect_fig_reference_page.py`
collects authored geometry, original image bytes and provenance from a decoded local
archive; it does not approve examples or resolve every component. Save resolved MCP
bounds and actual Figma renders separately. `crop_reference_renders.py` distinguishes
padded MCP section screenshots from unpadded frame/native exports.

An explicit review plan selects inspected examples, annotations, positive/negative
status, campaign IDs, adaptation families and reusable assets. Build a portable bundle:

```sh
data/knowledge/.venv/bin/python scripts/knowledge/build_reference_bundle.py \
  --brand-dir data/brands/BRAND \
  --page-dir data/brands/BRAND/snapshots/PAGE_COLLECTION \
  --review-plan REVIEW_PLAN.json --out REVIEWED_BUNDLE
```

`referencePacks` add concrete materials and layout anchors to a positive example.
Each use identifies the source node and original image paint (or a reviewed isolated
node export), its role, and whether to preserve it or replace it for the brief.
`resolvedLayersFile` supplies separately saved MCP geometry when available. Normalized
visual-frame coordinates retain source transforms, typography, paint, opacity and
limitations. Rotated source frames are not mistaken for portrait templates.
`derivedAssets` distinguish rendered node exports from original image fills and retain
their source hashes. Never use an entire banner screenshot as a reusable material.

Set `authoringMode: "reference-adaptation"` in a reviewed plan/profile to retrieve
ready reference packs first. The runtime preserves semantic ranking, then pins the
selected references' approved backgrounds/materials/decor before unrelated asset hits.
It reserves capacity for the brief's product assets and never pins source products
marked `replace-with-brief`. Original transparent padding is retained when source
placement depends on it. Missing packs fall back to normal reference search; resize
still prioritizes the existing creative family. This requires explicit curation;
it is not automatic classification of every archived image.

Build and validate the bundle before calling the existing atomic importer. A page
refresh can replace generated evidence for that page while retaining other pages,
legacy records and old snapshots. The examples below describe the earlier initial
corpus; current coverage belongs to each snapshot's `coverage.json`.

The earlier `brandbook.py` corpus is retained. The new standalone `brand_library.py`
uses `data/brands/<brand-id>/catalog.json`, immutable snapshot directories, and an
per-snapshot index activated by an atomic catalog pointer (the initial X5 snapshot
uses the compatible per-brand `index.sqlite`). It is connected only to the new
editable Banners studio, not to the animation agent. The studio retrieves evidence,
composes editable layers, renders them locally and supports chat edits and resizes. All101 X5 source frames and225 inventoried asset fills are now saved and reviewed.
The MCP quota interruption was recovered through a full local .fig export from the
Figma desktop app. Authored geometry is available for18024 nodes; a full component/
variable renderer remains outside this ingestion. Four locally installed X5 Sans
font files were separately saved and fingerprinted as brand resources.

Each record has kind (rule/editorial/example/asset/measurement/composition), scope,
authority (explicit/observed/inferred), polarity (positive/negative/mixed/neutral/unknown),
review status, source node IDs/URL, file/image SHA-256 and optional normalized region,
relationships and review provenance. A visual example needs an inspected image;
an asset needs actual bytes. Extracted names/categories alone remain unreviewed.
Document presentation layouts are distinguished from advertising examples. A
measurement from one layout must not become a global spacing/radius token. Unknown
measurements remain unknown. Conflicting source statements are preserved and
explained; dates, prices and percentages in sample ads are not current offer facts.

Ingestion procedure for any brand:
1. Inventory all source pages/frames/assets and record expected counts before reading.
2. Save immutable full frames plus source text/geometry and original asset bytes.
   Bound MCP responses by bytes and persist cursors; stop on a quota error. Never
   treat a truncated subtree as a complete export. Download temporary URLs promptly;
   keep URL manifests private and do not put them in records/Git.
3. Review the actual images and adjacent explanations. Mark positive/negative regions
   and relationships explicitly. Record normative rules separately from observations,
   inferred composition advice and literal example copy. Preserve exceptions/channel.
4. Classify asset subject, material, color, view, transparency, completeness and usage.
   Partial trolley/basket components are not complete objects. Keep source provenance.
5. Use `import_brand_snapshot.py BRAND BUNDLE --name NAME --embed` for a reviewed bundle
   containing source.json, records.json, coverage.json, optional resources.json
   (fonts/logos with file/SHA-256), optional authoring.json, and referenced files. The
   importer validates evidence first, copies only referenced files, builds the complete index in staging, preserves old
   snapshots and atomically activates the new catalog only after success. A failed
   import leaves the old catalog and index available. No automatic extraction
   approval and no automatic live-Figma refresh. Collecting/reviewing a new brand is
   still an explicit workflow, not a one-click fully autonomous importer.
6. Build/inspect retrieval, test held-out briefs and forbidden-example confusion,
   and review resulting designs before calling the brand production-ready.

`brand_library.py build x5 --embed` embeds reviewed cards with the existing local
multilingual E5-small cache (384 dimensions); untruncated tokenizer input is checked
against512 tokens. It indexes reviewed text/descriptions, NOT pixel embeddings.
SQLite FTS5 + exact cosine retrieve30 each, RRF merges, multilingual BGE reranks up
to30 candidates while reserving ten from each retrieval channel. Results include
linked anti-examples and mandatory rules separately. Scores are not confidence.
Search checks catalog/source/records fingerprints, embedding model files and hashes
of returned evidence. Separate brand databases prevent cross-brand retrieval.

`brand_library.py search x5 'QR-карта без телефона' --mode hybrid`
`python3 -m unittest discover -s scripts/knowledge -p 'test_brand_library.py'`

The UI `/#banners` creates four editable banner variants by default (or1–12 as
requested), with a selected brand, brief and dimensions. The search/media APIs
remain available; the old retrieval-only screen has been replaced. The animation
agent remains disconnected from brand retrieval.

### Authoring profile and runtime

A brand that supports composition needs `authoring.json`, either beside catalog.json
or at its `authoring` pointer. Profile version1 contains `snapshot`, `resources`,
`requiredEvidence`, plus optional palette/notes. Each resource has a stable `id`,
`kind` (logo/font), contained `file`, `sha256`, and a display name. Fonts supply the
actual `family`/`style`; logos supply actual width/height and `clearspaceRatio`
(clearspace divided by full logo height), with source provenance. These values must
come from that brand's evidence, not universal defaults. The portable importer
rewrites resource paths and profile snapshot together and checks evidence IDs before
activation. New-brand collection and visual review are still an explicit workflow.

`apps/scene-validator/src/banners/service.ts` calls the existing Codex SDK adapter,
without subagents. It retrieves brand evidence and actual images, creates typed
layer documents, measures text using original fonts and renders editable SVG plus
PNG with resvg. `composition.ts` supplies general composition guidance, separate
from explicit brand rules. Bounded layout repair preserves copy and asset identity;
vision review compares rendered output and references. Suggestions do not refuse
otherwise valid work. Technical checks do not certify aesthetic or brand quality.

Krea generates only missing standalone KV assets through the existing connected
Codex app-server MCP transport. No separate Krea API key is required. The current
KV model can be chosen in the create form; it does not generate typography or the
whole banner. Isolated objects use a plain background plus local real-alpha
extraction; photographic scenes preserve their background. One-time optional setup:

```sh
data/knowledge/.venv/bin/python scripts/knowledge/banner_cutout.py --setup
```

This downloads checksum-verified U2Net ONNX weights from the maintained rembg release
into ignored `data/knowledge/banner-models`. It uses the existing numpy/onnxruntime/
Pillow environment. A render never silently downloads weights. Sources:
[U2Net](https://github.com/xuebinqin/U-2-Net),
[rembg](https://github.com/danielgatis/rembg),
[Krea image API](https://www.krea.ai/docs/api-reference/image/chatgpt-2).
Actual cutout edges and style still need visual review; segmentation is not infallible.

Private banner projects live in `data/banner-projects/<uuid>` with pinned resource
hashes, job traces and numbered revisions. Chat emits minimal patches on the selected
variant; resizes preserve the exact content/asset/layer identities. Undo follows
content ancestry. ZIP contains JSON, resources and each SVG/PNG. Automatic Figma
publishing and durable job resume are not implemented. Runtime assumes one local
server; interrupted jobs preserve the last committed revision.


## Large Figma files: local snapshot route

Prefer one complete **Save local copy** from the authorized Figma file when many
individual MCP exports would consume its quota. Keep the `.fig` archive private.
It retains the source bytes even when MCP paginated geometry extraction is partial.
The archive must finish downloading all images; do not call a partial save complete.

`extract_fig_assets.py SOURCE.fig INVENTORY.json OUTPUT_DIR` matches `assetNodes`
from the source inventory by Figma image hash, verifies SHA-1, saves original bytes
and SHA-256/pixel/alpha metadata, and extracts `canvas.fig`/`meta.json`. It extracts
only named entries, not arbitrary ZIP paths. Every collected asset initially remains
`downloaded-unreviewed`. Review the actual images before promoting evidence records.
Original image fills preserve the full image; they are not a flattened rendering of
Figma node crop, masks, rotation or effects. Keep node geometry alongside them.

Optional offline geometry decoder (Node24+ for Zstandard):

```sh
python3 scripts/knowledge/setup_fig_decoder.py
node scripts/knowledge/decode_fig.mjs OUTPUT_DIR/canvas.fig OUTPUT_DIR/decoded.json
python3 scripts/knowledge/normalize_fig_geometry.py OUTPUT_DIR/decoded.json OUTPUT_DIR/geometry.json PAGE_ID_1 PAGE_ID_2 PAGE_ID_3
```

Setup downloads pinned `kiwi-schema@0.5.0` from npm and checks registry SHA-512
integrity. Source: [Kiwi's maintained implementation](https://github.com/evanw/kiwi),
with the .fig container also documented by [Sketch's importer](https://github.com/sketch-hq/fig2sketch/blob/main/src/figformat/decodefig.py).
No brand content is transmitted. The decoder validates embedded schema identifiers
before compiling decoders; decoded document values are never executed. It supports
bounded raw-deflate/Zstandard chunks and complete unique-node snapshots. Other
snapshot/format versions require verification, not silent interpretation.

Normalization selects only explicit page IDs and preserves authored node-local
transforms, sizes, text/style fields, corner radii/smoothing, layout spacing/padding,
paints and ancestor visibility. Internal library canvases are excluded unless chosen.
It is not a Figma renderer: component overrides, variables and derived glyph geometry
are not fully resolved. Per-reference geometry files are linked and hashed in reviewed
records. Geometry does not automatically become a global brand token. New-brand
visual interpretation and correct/incorrect region classification are still explicit
review work; these scripts automate collection and storage, not artistic judgement.

## Using the evidence for banner design

Start from the actual brief: audience, offer facts, required copy/logo/legal text,
channel, dimensions and output format. Do not invent prices or terms from source ads.
Retrieve applicable explicit rules first, then positive composition references and
assets; inspect both source images and linked negative examples. Keep brand/editorial
requirements separate from observed layouts and general design judgement.

Use one clear visual hierarchy: primary message, image/benefit, action/supporting copy.
Choose line breaks and text width together; inspect actual glyph rendering at output
size. Align groups deliberately, use whitespace to separate meaning, maintain contrast
and protect required copy from crop/overlap. Adapt each aspect ratio by rearranging
semantic groups, not by stretching or uniformly shrinking a complete layout. Source
spacing/radius measurements guide a matching reference only; allow different values
where the composition requires them and no explicit brand rule forbids them.

Before delivery, render every requested size, inspect original assets and actual font,
check copy/facts, clipping, unintended overlaps and visual hierarchy. Report missing
facts or contradictory source evidence specifically. Technical checks are diagnostics;
they must not become an expanding set of arbitrary aesthetic rejection thresholds.
This cycle is implemented in the banner studio. Source analysis and inspection of new
brand bundles remain explicit review work; no geometric test guarantees visual quality.
