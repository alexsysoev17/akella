# Motion guidelines
Optional artistic advice, never a style veto.

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
For eased motion with negligible endpoint momentum, an explicit
velocitySampling=lookback uses the bounded velocityLookbackFrames incoming window.
It is a deliberate momentum-window model, not instantaneous endpoint velocity;
state that assumption. Omitted velocitySampling preserves endpoint behavior.
Stationary motion never acquires an invented physical impulse.
