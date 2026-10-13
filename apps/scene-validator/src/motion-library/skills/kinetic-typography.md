# Kinetic typography
Recommendations only: explicit user direction wins.
Protect headline hierarchy and time to read. A restrained translation/fade or scale often works better than several competing effects. Stagger real text layers when the source has them; do not pretend a single text node has independently animatable words. Hold important messages before the exit. Large overshoot can briefly reduce readability; the user can intentionally request this. Typography remains structured source content; animate container transforms without replacing text with pixels.

Slide Up + Fade + Overshoot changes position and opacity only; it must not add text clipping. Use explicit `maskReveal` only when the user requests a mask reveal. It clips an effect wrapper from measured source and loaded text line boxes and removes its clip at progress 1; source Frame clipping and Figma masks remain active. Never copy font aliases between different scenes.
