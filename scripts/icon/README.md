# BridgeClip app icon

The app icon is a simple gold-and-cyan C with a play symbol on a charcoal rounded tile. The colors and ribbon fold connect it to BridgeMind. The official family mark and wordmark have their own source in `resources/bridgemind-mark.svg`.

## Source and exports

- **Source:** `resources/bridgeclip-icon.png`, the unmodified 1254 × 1254 RGBA output from the built-in imagegen tool, generated September 24, 2026.
- **App assets:** `build/icon.png` (1024px), `build/icon.icns` (macOS), and `build/icon.ico` (Windows: 16, 24, 32, 48, 64, 128, 256px).
- **Renderer/public compatibility assets:** `resources/bridgeclip-icon.svg` (1024px) and `resources/bridgeclip-icon-small.svg` (128px). These embed PNG data; they are not vector masters. The app's 48px icon uses the compact export, with enough resolution for Retina displays.
- **Preview:** open `scripts/icon/icon.html` to inspect 16–128px sizes against dark and light surfaces.

Run `npm run icons` on macOS (Node, sips and iconutil required). All sizes are exported directly from the source, preserving its transparent outer padding. Generation is not rerun, and no image API credentials are needed to rebuild. To revise the artwork, use imagegen, replace the source PNG, then run the exporter. Do not edit generated assets individually.

## Final generation prompt

Mode: built-in imagegen, new image, no reference images. No CLI fallback was used. The requested canvas was 1024px; the tool returned 1254px, retained as the master and downsampled for platform formats. The model rendered the play symbol as a cyan triangle inside the C.

```text
Use case: logo-brand.
Asset type: production desktop app icon for BridgeClip, an AI video clipping app in the BridgeMind product family.
Primary request: Create one exceptionally simple, distinctive, beautifully balanced app icon. A single bold geometric C/clip emblem with a right-facing play triangle in its negative space. The C is built from only two broad complementary ribbon segments: warm golden yellow on the upper/left segment, vivid cyan blue on the lower/right segment. The two segments form one cohesive silhouette; their angled cut ends and restrained folded-ribbon geometry subtly evoke the BridgeMind brand. Make the play-shaped negative space immediately legible. Prioritize a memorable shape and thick clean geometry that holds up at 16px.
Scene/backdrop: a solid near-black charcoal (#101116) rounded-square desktop icon tile, centered, front-facing, on a genuinely transparent outer canvas. The tile occupies about 82% of the square canvas (roughly 9% clear padding on every side), with smooth continuous rounded corners. The emblem occupies about 62% of the tile width, optically centered.
Style/medium: meticulous minimal flat brand design, crisp antialiased edges, two solid bright colors, clean confident silhouette, ample breathing room. Only an extremely subtle edge highlight on the charcoal tile, if needed. Icon artwork, not a photographed object or presentation mockup.
Color palette: BridgeMind gold #FFD000 and cyan #30C5F4 with charcoal #101116.
Text: none.
Constraints: square 1024x1024 PNG with genuine transparent alpha outside the tile. One icon only, fully inside the canvas.
Avoid: crop brackets, trim sliders, film perforations, scissors, brains, circuitry, lightning bolts, tiny lines, lettering, a separate floating play button, extra badges, glossy 3D, bevels, texture, noisy gradients, glow, drop shadows outside the tile, checkerboard drawn into the image, mockup backgrounds, multiple variations.
```
