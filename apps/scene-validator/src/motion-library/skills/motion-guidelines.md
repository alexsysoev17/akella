# Motion guidelines
Optional artistic advice, never a style veto.

For inertia, the user-approved reusable procedure is in inertia-continuity.md.
Its principle is authoritative guidance; example numeric values are not defaults.

Direction priority: current explicit request, project/scene technical constraints,
approved project style profile, then general guidance. Read motion-timing,
animation-principles and kinetic-typography for their respective details.
Prefer a clear primary action, readable pauses and coordinated entrances/exits;
use stagger to clarify hierarchy. Smooth endpoints and faster central movement
are useful defaults only when the user has not chosen another profile.
Keep cross-scene logical identity and authored reference poses continuous.
Explicit procedural damping requires a real expression or transition effect,
not a sequence of oscillating keys. Follow-through and base movement are separate
editable controls. New transition displacement uses canvasPixels; absent space
means historical legacyProgress and must not be silently reinterpreted.
After-transition inertia uses a transition-bound inertialOvershoot expression.
For no translation or zero incoming velocity, report that limitation and choose
an explicit user-visible procedural assumption rather than inventing velocity.
To convert existing oscillating keyframes, use the typed convertKeyframeInertia
tool. It preserves track identity, original duration/dependency anchors and easing,
replaces the oscillating tail with a neutral hold and a genuine velocity-driven
expression, atomically. Supply local motionEndFrame when the primary movement
boundary is ambiguous; settleFrame can explicitly stop inertia before the next
transition. This is a technique conversion, not a pixel-identical reproduction
of arbitrary hand-authored keys. Inspect feedback and preserve unrelated tracks.
Coordinate the primary action and secondary effects; avoid stacking several unexplained bounces. Start from a preset when useful, then edit its expanded parameters independently. Never restore preset defaults during a local edit. Prefer the smallest change satisfying a correction: two consecutive requests to halve amplitude mean current amplitude × .5 each time. Frequency, decay, stiffness, damping, duration and Bezier points are independent controls. Reduce decay for slower damping; reduce damping for a less damped spring. Keep expression IDs, animation IDs, target and timing unless the request needs them changed. Strong, abrupt, exaggerated or deliberately chaotic motion is valid when the user asks for it; only schema, finite-value, target and compositing constraints are mandatory.

Default oscillation, floating and follow-through to actual procedural expressions,
not alternating hand-written keys. Keyframes remain appropriate for primary poses.
Ongoing secondary motion uses logicalObject ownership and global-time duration;
do not end/reseed it merely because a Figma reference scene changes. Typed addEffect
resolves this ownership when unambiguous; explicit sceneInstance remains scene-local.
Source-bound logical inertia retains its base source, start and decay interval.
Historical velocitySampling=lookback uses a secant window and may create a speed jump after an eased stop. Do not use it as the default fix for weak inertia; use tuneInertia as described below. Omitted velocitySampling preserves endpoint behavior.
Stationary motion never acquires an invented physical impulse.

## Velocity-matched inertia (tuneInertia)
For an ordinary request for visible, smooth inertia, create the base and a linked
inertialOvershoot, then use tuneInertia with approach=adapt. It fits an explicit
inertiaHandoff curve: the original easing is retained before the chosen join,
then a quintic Hermite arrival meets the procedural tail with the same position,
velocity and acceleration. The fitter avoids a second acceleration after braking;
one matching endpoint derivative alone is insufficient. Only the final segment of a multi-key track is adjusted. Timing, poses,
segmentation and stagger are retained. The bridge may need to start earlier for
strongly eased stops; inspect the reported join and preview the whole approach.
This is an intentional change to the approach, not a claim of unchanged easing.
For explicitly fixed curves use approach=preserve; a flat endpoint can correctly
give zero visible inertia. Never replace that with a hidden lookback impulse.

For new coupled responses, the internal tail coefficient is 1/(2*pi*frequency),
so its initial derivative matches the actual endpoint speed. The stored amplitude
remains an artistic strength control: changing it refits the linked approach
rather than multiplying the initial tail speed. Frequency, decay and durations
also reconcile at canonical edit time. Strength comes from approach velocity and the
requested peakRatio (tail peak / final-segment travel); frequency and decay shape
the settling. The fitter accounts for available tail duration and smoothTail.
It can reduce a requested peak to avoid braking then pushing again;
measure the resulting peak, don't present the request as the measured result.
A local numerical derivative and the actual evaluator work for linear, accelerate,
decelerate, fast-middle Bezier and custom curves; don't assume all easing names
have the same terminal speed. Absence of the new fields preserves historical math.

Compare six frame steps on both sides, incoming/outgoing speed and acceleration,
peak at displayed scale, settling residual and
ambient wiggle separately. Small movements may need a larger relative peak than
large entrances. Wiggle is not inertia: preserve it when requested, reduce its
competition when correcting readability, never add it to disguise a weak tail.
These observations guide editing; they are not artistic pass/fail gates. C2
continuity does not prove continuous jerk, legibility or overall video quality.
Stored C1 bridges are not silently migrated. Editing the base easing of an already coupled response refits its arrival against
that new curve. For an explicitly literal/fixed curve, use tuneInertia preserve
in the same edit batch to opt out of this coupling. For a shared multichannel source, the selected response gets C2
coupling; sibling tails are velocity-matched, not independently C2-tuned.


## Whole-trajectory continuity
When the user still perceives a keyed stop after a locally smooth handoff, inspect
the complete motion, not only one scalar derivative. A state transition changes
X, Y, rotation and scale together; adding only an X tail can leave other channels
stopping abruptly. co-timed X/Y tracks should continue their vector together.

`tuneInertia approach=continuous` explicitly rebuilds the complete single approach
from rest as a seventh-degree curve, matching value, velocity, acceleration and
jerk to the damped tail. It keeps poses and timing, not the original easing. The
original curve remains in metadata; use preserve when literal easing matters.
It creates missing transform companions for a transition/moveTo and aligns
co-timed scalar XY entrances. Existing disabled/deleted companions are not
resurrected by later automatic strength edits. Whole-pose continuity must be
checked on rendered corners/anchors, not merely X offsets. Nonuniform scale and
shear under rotated parents remain outside the verified matrix of cases.

Do not shorten a meaningful tail to fit a Figma scene marker: use logical carry
when the same object starts another transition, or explicitly retime the motion.
A high-frequency tiny tail after a long braking phase can feel like vibration.
Choose speed, frequency, decay and desired travel together, and inspect the
frame increments before/after the crossing. C3 alone does not prove a good clip.
