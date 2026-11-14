# Continuous inertia — approved authoring principle

User-approved on 2026-11-09. The approval establishes a motion principle, not a
universal numeric preset and not approval of every future output.

## Principle
Treat approach and settling as one motion of the whole object. Do not finish a
braking animation and then attach a second push. Follow X/Y, rotation and scale
through the arrival together. A smooth scalar X trace does not prove a smooth pose.

For a new rest-to-rest movement with perceptually continuous inertia, prefer
`tuneInertia` with `approach: "continuous"` after creating the movement and its
inertialOvershoot. It rebuilds the single approach from rest and matches velocity,
acceleration and jerk to the procedural response. It continues transition/moveTo
channels and co-timed scalar XY tracks. Use `preserve` for a fixed literal curve;
use `adapt` for a localized authorized arrival change. Do not silently rewrite a
user-specified curve. Ongoing movement is not a rest launch; inspect its incoming
velocity and choose a suitable existing technique instead of restarting it.

## Work from this project's geometry and time
- Derive entrance distance from transformed bounds, canvas edge, direction and a
  suitable margin. Neither 1200px nor the margin used in a previous project is a
  default. A huge invisible approach can produce an unnecessarily fast visible entry.
- Choose frequency, decay and overshoot together with movement duration, distance,
  object size, FPS and available settling time. Inspect f*T and decay*T as well as
  pixel displacement. The approved example's 1.25Hz / 3.8s^-1 are reference values,
  not mandatory constants. A tiny rapid oscillation can read as a new vibration.
- Reserve actual settling time. Preserve logical identity/phase through a reference
  scene transition when appropriate; do not force the tail to end at a scene marker.
- Inspect every moving pose channel. New continuous transition scaling uses the
  object's local axes, including rotated/nonuniform/reflected poses. Saved effects
  without the version flag retain their original canvas-axis composition.
- In a coupled response amplitude is an artistic strength control which refits the
  approach. It is not the standalone sine coefficient. Subsequent edits must go
  through canonical tools so amplitude/frequency/decay/duration remain coordinated.
- Wiggle is independent ambient movement, not a replacement for follow-through.

## Observe, then judge
Inspect several actual frame increments on both sides, speed/acceleration/jerk,
all rendered corners/anchors, actual peak and residual, fade visibility and scene
handoffs. Render representative frames/the clip at viewing scale. Check readability
and overlaps separately. Tests protect technical continuity; they do not decide
whether an artistic choice is allowed or prove aesthetic quality.

Do not claim requested peak equals achieved peak: the fitter can reduce it, even
to zero. A zero response on a moving object does not satisfy a request for visible
inertia; adjust timing/frequency/strength or choose another supported approach.
Do not manufacture an impulse on a stationary source.

## Scope and known limits
Continuous mode rebuilds a single segment from rest; arbitrary multi-key motion,
independent shear animation, changing reflection sign, and all nested nonuniform
parent combinations are not generally proven. Do not flatten arbitrary keys or
restart an already moving object to force this tool to fit. Scalar C3 continuity
is not a blanket world-space C3 guarantee. Preserve alternatives and inspect the
actual composed pose. These limits are disclosure, not new global style gates.

Regression tests use independent generated inputs without project/client IDs:
`tests/inertia-generalization.test.ts` and `tests/native-inertia-generalization.test.ts`,
plus existing `tests/inertia-tuning.test.ts` and native continuity coverage.
