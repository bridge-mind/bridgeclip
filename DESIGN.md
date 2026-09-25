# BridgeClip Design System: Flat Glass

BridgeClip is built from flat translucent layers over one solid dark backdrop. **There are no gradients anywhere, and no coloured glows**: every fill is a single colour, and the only shadows are black depth shadows and crisp 1px rings. Surfaces float, and the controls are capsules. It is still a working tool people keep open for hours, so the glass stays calm and the video stays the loudest thing on screen.

Tokens live in `src/renderer/globals.css` (as RGB channels, plus the material classes) and are mapped to Tailwind names in `tailwind.config.ts`. Reusable pieces live in `src/renderer/components/ui/`. Use those before writing new class strings.

---

## Principles

1. **Layers, not boxes.** Every surface is a material (below) sitting at a depth: backdrop → panels → tiles inside panels → floating bars and dialogs. Don't draw a flat grey rectangle.
2. **Flat fills, crisp edges.** Every fill is one colour (no `linear-`/`radial-gradient`, no `bg-gradient-*`, no blurred colour blobs, no coloured blurred shadows). Panels have an even 1px rim; controls may have a 1px inner highlight on their top edge. Only black shadows blur.
3. **Video first.** Thumbnails, previews and caption samples carry the colour. Glass is neutral so it never competes with footage.
4. **Accent is solid and scarce.** The blue accent is for the primary action, chosen options, live progress, the active nav icon and the drop target. Selection elsewhere is a brighter pane of glass, not blue.
5. **Only failure earns a hue.** Red means something broke, amber means setup is incomplete or a result needs a look, green means found/ready/saved.
6. **Say what happened.** Errors show the engine's actual message and a suggested fix, never just "Something went wrong".

---

## Materials (`globals.css`)

| Class | What it is | Use |
| --- | --- | --- |
| `app-backdrop` | Solid `canvas`, opaque, so the macOS vibrancy under the window never tints the UI. Shared by the sidebar and the page. | The window background (Layout, loading screen). |
| `glass` | Flat translucent fill, 1px inset rim, floating black shadow. `position: relative`. | Panels, cards, empty states. Needs a `rounded-*`. Don't add a `border` utility; the rim is the edge. |
| `glass-thick` | Flat darker tint with `backdrop-filter: blur(40px) saturate(170%)`, rim and deep shadow. | Anything floating over scrolling content: dialogs, sticky toolbars, popovers. |
| `glass-tile` (+ `glass-tile-hover`) | Flat lighter fill, hairline border, inner highlight. No blur. | Rows, option cards and sub-sections inside a panel. |
| `glass-selected` | Flat accent tint with an accent border and a crisp 3px ring. Combine with `glass-tile`. | The chosen option card or tile. |
| `glass-well` | Recessed dark well with inner shadow. | Text inputs, selects, text areas, inset lists (system check). |
| `glass-chip` | Small frosted label with blur. | Anything overlaid on video or artwork (score, duration, counts). |
| `btn-primary` / `btn-glass` | Solid accent capsule / flat glass capsule. | Used by `Button`; don't apply directly. |
| `scroll-edge` | Solid `canvas` title-bar strip that content scrolls under. | Layout only. |

Blur is expensive. Only `glass-thick` and `glass-chip` use `backdrop-filter`. Panels and tiles don't need it: they sit on the solid backdrop.

`prefers-reduced-transparency` turns the materials solid and drops blur. `prefers-reduced-motion` stops animation.

---

## Color

| Token | Value | Use |
| --- | --- | --- |
| `canvas` | `#07080C` | Backdrop base |
| `surface` · `raised` · `overlay` | `#0E0F15` · `#16181F` · `#1A1C24` | Solid fallbacks (options menus, reduced transparency) |
| `ink` | `#F7F8FC` | Primary text, active icons |
| `ink-muted` | `#AAAEBC` | Secondary text, descriptions |
| `ink-subtle` | `#7C8190` | Hints, metadata, eyebrows |
| `ink-faint` | `#545967` | Placeholders, disabled, nav group labels |
| `line` / `line-strong` | white 9% / 16% | Hairlines and dividers (`divide-white/[0.06]` inside tiles) |
| `fill` / `fill-hover` / `fill-selected` | white 5% / 8% / 11% | Plain hover and pressed surfaces |
| `accent` / `accent-hover` | `#5C8FFF` / `#86B0FF` | Primary buttons, chosen options, progress, focus ring |
| `accent-cyan` | `#38CCFF` | The BridgeMind mark's blue. Not used for UI fills. |
| `success` · `warning` · `danger` | `#4ADE80` · `#FBBF24` · `#FF6B6E` | Status only |
| `brand.gold` | `#FFD500` | The virality score icon |

Every token supports alpha modifiers: `bg-accent/10`, `text-danger`. Don't use `from-`/`via-`/`to-` gradient stops.

---

## Typography

- **Geist** for UI and **Geist Mono** for numbers, timecodes, paths and costs. Both are vendored in `assets/fonts/` (SIL OFL 1.1), so the app renders the same offline.
- UI text is 13px (`text-sm`). The scale is `2xs` 11, `xs` 12, `sm` 13, `base` 14, `lg` 16, `xl` 20, `2xl` 24, `3xl` 30, `4xl` 40.
- Page titles: `text-xl` (`text-2xl` from `xl`) `font-semibold`, optionally with an `.eyebrow` above. Panel titles: `text-sm font-semibold`; panel descriptions `text-xs`.
- Numbers that change or line up (percentages, timecodes, costs) use `font-mono tabular`.

---

## Shape and depth

Corners are soft and **concentric**. A shape nested inside another with padding `p` uses the outer radius minus `p`. For example, a clip card is `rounded-2xl` with `p-1.5`, and its media is `rounded-xl`.

| Radius | Px | Use |
| --- | --- | --- |
| `rounded-full` | — | Buttons, badges, chips, segmented controls, switches, status pills |
| `rounded-xl` | 12 | Inputs (`lg`), nested media, small tiles, setting rows, callouts |
| `rounded-2xl` | 14 | Tiles, cards, rows |
| `rounded-3xl` | 18 | Panels, dialogs, the drop zone |

Depth, back to front: `app-backdrop` → `glass` panel → `glass-tile` / `glass-well` inside it → `glass-thick` floating bar or dialog. `shadow-accent-ring` marks a selected card. `shadow-pop` is for anything custom that floats.

---

## Layout

```
┌ app-backdrop (solid canvas) ──────────────────────────────────────────┐
│ ┌ sidebar (flush, border-r) ───────┐   ┌ title-bar strip: drag + scroll-edge ┐
│ │ ● ● ●                            │   └──────────────────────────────────────┘
│ │ [BridgeClip]                [⇤]  │     #page-scroll (pt-10)
│ │ STUDIO                           │     <Page width="…">
│ │  ✦ Create        ⌘1              │       PageHeader
│ │  ▦ Library       ⌘2              │       glass panels …
│ │  ≡ Jobs          ⌘3              │
│ │ WORKSPACE                        │
│ │  ⋈ Accounts      ⌘4              │
│ │  ➤ Posts         ⌘5              │
│ │  ⇄ Automations   ⌘6              │
│ │  ⚙ Settings      ⌘,              │
│ │ [running job card]               │
│ │ ● Ready to clip           v0.x   │
│ └──────────────────────────────────┘
└────────────────────────────────────────────────────────────────────────┘
```

- The sidebar is collapsible: a 200px column, or a 72px icon rail (mark-only logo, icons with `aria-label`/tooltips, group labels hidden). The toggle lives inside the sidebar: expanded, it sits at the right of the logo row; in the rail, the brand mark is the toggle and shows the expand icon on hover or focus. ⌘\ also toggles it, and the choice is remembered (`store/use-sidebar-store.ts`). Windows narrower than 1024px always get the rail, where the mark is only a mark. The app version sits in the footer beside the setup status. It has no background of its own: it shares `app-backdrop` with the page and is separated by a `border-white/[0.06]` hairline. The macOS traffic lights sit in its top 40px strip (`trafficLightPosition` 16,12). The window's minimum size is 720×520.
- Pages scroll under a solid 40px title-bar strip (`scroll-edge`). The strip and the backdrop are drag handles; interactive elements opt out with `.no-drag`.
- Sticky elements inside a page use `top-12`, because sticky ignores the scroll container's padding.
- Wrap every page in `<Page width>`: `focus` 720 (progress, failure), `narrow` 880 (Settings, Accounts, Posts), `default` 1280 (Jobs), `wide` 1680 (Library, results). Create uses `narrow`. Gutters are `px-4`, `sm:px-6`, `xl:px-8`.
- **Compact by default.** Panels pad `p-4` (`xl:p-5`), stacks use `space-y-3`/`gap-3`, sections `mt-4`/`mt-5`. Don't reintroduce `p-6`+ or `mt-8`+. Media grids use `repeat(auto-fill, minmax(…))` so column count follows the window.
- **Create is a wizard**: Video → Format → Clips → Captions → Review, one compact panel per step under a clickable stepper, with Back/Next (and Generate) pinned to the bottom edge on a solid strip. ⌘↵ generates from any step once a video is chosen. After Generate the job is queued and the wizard offers "Clip another video", so several runs can be queued back to back. Step and draft live in `use-draft-store`.

---

## Components (`components/ui/`)

| Component | Notes |
| --- | --- |
| `Page` | Page column with width presets and the entry animation. |
| `PageHeader` | Optional `eyebrow` and `leading` (back link), title, description, right-aligned actions. |
| `Panel` / `PanelHeader` | `glass rounded-3xl p-6`. The header takes an `icon` (an `IconTile`), a title, a description and an action. |
| `Button` | Capsules. `primary` (solid accent) · `secondary` (glass) · `ghost` · `danger`. Sizes `sm` 28px, `md` 32px, `lg` 40px. `iconOnly` makes it round (needs `aria-label`). `loading`. |
| `TextInput` · `TextArea` | Recessed `glass-well`s with a crisp accent focus ring. `TextInput` `sm` is 28px, `md` 32px and `lg` 40px, matching Button heights, with `leading`/`trailing` slots and `mono`. |
| `Select` | The app's dropdown (never a native `<select>`): a `glass-well` combobox button (`md` 32px, `sm` 28px) that opens a `glass-thick` menu with a check on the chosen option, muted `detail` text and disabled rows. Takes `options`, `placeholder`, `emptyText`, and `searchable` for long lists (time zones). Keyboard: arrows, Home/End, Page Up/Down, type-ahead, Enter/Space, Escape (closes only the menu, never the dialog around it). The menu is a top-layer popover, so panels and dialogs never clip it. `MENU_SURFACE` and `menuOptionClass` style any other menu (the model picker uses them). |
| `Field` | Label, optional `aside` (e.g. "Get a key"), hint. |
| `Segmented` | Single choice in a glass track, with the chosen option as a raised pill. Roving tab stop. Also exports `onRadioKeyDown` for custom radio groups. |
| `SettingRow` | Title and description with a control (usually `Switch`) on a `glass-tile`. `bare` drops the tile. |
| `Switch`, `Checkbox` | Solid accent when on. The checkbox supports `indeterminate` and `variant="overlay"` for use on video. |
| `Badge`, `StatusDot` | Tinted glass pills; tones `neutral` · `accent` · `success` · `warning` · `danger`. Dots are solid and can pulse. |
| `IconTile` | A flat tinted tile holding an icon. Sizes `sm`–`xl`, same tones. |
| `Callout` | Tinted glass strip for errors, warnings, info and success, with optional title, action and dismiss. `role` is alert for danger, status otherwise. |
| `ProgressBar` / `ProgressRing` | Solid accent fill, red when failed. The ring renders its children in the centre. |
| `EmptyState` | Glass panel with an icon tile, title, one sentence and one action. |
| `Skeleton` | Flat loading block that pulses. |
| `HoverCard` | A read-only rich tooltip: hover or focus shows a `glass-thick` card under the trigger (above it when there's no room), as a top-layer popover. Escape closes it. |
| `Dialog` / `DialogFooter` | Dimmed, blurred backdrop and a `glass-thick` panel (`layer="system"` for the update prompt). Callers own focus trapping and Escape. |

Brand: `components/brand/BridgeClipLogo` renders the lockup (`variant="lockup"`, size by height), the app-icon tile (`variant="icon"`) or the family mark alone (`variant="mark"`, for the icon rail). `resources/bridgemind-mark.svg` embeds the official BridgeMind symbol and is the source for the lockups generated by `scripts/icon/build-logo.py`. The app icon has its own simple clip/play emblem in BridgeMind gold and cyan on a charcoal tile. Its imagegen master is `resources/bridgeclip-icon.png`; `npm run icons` exports PNG, ICNS, ICO and self-contained raster-backed SVGs from that master, preserving transparency. The icon uses the same silhouette at every size. See `scripts/icon/README.md` for the generation prompt and `scripts/icon/icon.html` for the size preview. Edit the sources, not the exports.

---

## Patterns

- **Option cards** (format, framing, caption style): `glass-tile glass-tile-hover` at rest, plus `glass-selected` when chosen. Visual tiles also get a check badge.
- **Chips** (clip length, job filters): capsules. Chosen chips use the accent tint.
- **Media cards** (clips, runs): `glass` card with the media inset concentrically, and only a title and one line of metadata under it. Overlays are `glass-chip`s (no gradient scrims over media). The media is the play button. On hover the card lifts 2px, a frosted play lens appears, and the card's actions (post, add to automation, show in Finder) show as small frosted buttons on the media; selected cards get `shadow-accent-ring`. A run opens with a stats bar (`RunStats`): clips, processing time, API cost and when it was created. Numbers count up once, with one quiet line under each. When a run beat OpusClip, processing and cost say so in green ("5× faster than OpusClip", "94% less than OpusClip") and hovering shows a small card with OpusClip's logo, that one number and its basis. OpusClip's numbers live in `config/opus-clip.ts` (update them with their `checked` date); no claim is shown when the run didn't win.
- **Floating toolbars** (clip selection): `glass-thick` bar, sticky at `top-12`.
- **Caption previews** mirror the clipping engine presets in `engine/clip_engine/config.py` (colours, outline, glow, casing, spacing, box and karaoke effects). If a preset changes in the engine, update `CaptionPresetPicker.tsx`.
- **Autosave**: Settings has no Save button. Keys save 600ms after typing stops and on blur, and paths save on blur or Enter. A "Saved" pill confirms it in the header.
- **Long work**: clipping runs in the main process's job queue (`src/main/job-manager.ts`): up to `MAX_PARALLEL_JOBS` (2) run at once and the rest wait in FIFO order. The Jobs page shows Active jobs (a small progress ring or queue position, stage, elapsed time, cancel) above Previous jobs (run history on disk, one line each: status dot, title, clips, run time, cost, date; the row opens the run, and the folder button shows on hover). Opening a job shows the progress ring with the four pipeline steps, its clips, or the failure with Run again. The sidebar shows a live count on Jobs and a card with the running jobs' progress.
- **Thumbnails** go through `lib/thumbnails.ts`, a one-at-a-time queue, because each one is a synchronous ffmpeg call in the main process.

---

## Motion

- Easing `ease-out` = `cubic-bezier(0.16, 1, 0.3, 1)`. `ease-spring` (slight overshoot) is only for the switch knob.
- Hover and state changes take 150–200ms. Pages enter with `animate-fade-in` (320ms, 6px rise), and dialogs with `animate-pop-in` (scale from 0.97).
- Motion communicates state: the pulsing ring on the active step, the skeleton pulse, the drop-zone scale. Nothing loops just to decorate.

---

## Accessibility

- A focus ring (`:focus-visible`, accent at 75%) appears on every control. Icon-only buttons carry `aria-label`.
- Radio-like groups use `role="radiogroup"`/`role="radio"` with `aria-checked` and a roving tab stop; toggles use `aria-pressed`; switches use `role="switch"`.
- Critical text is `ink` or `ink-muted`. `ink-subtle` is for secondary metadata only, and `ink-faint` is never for anything the user must read.
- Keyboard: ⌘1–⌘6 and ⌘, switch pages, ⌘\ collapses or expands the sidebar, and ⌘↵ generates clips (Ctrl on Windows and Linux).

---

## Adding UI

1. Reach for `components/ui/` first. If you're writing the same class string twice, it belongs there.
2. Pick a material for every surface (`glass`, `glass-tile`, `glass-well`, `glass-thick`, `glass-chip`). Don't use raw greys, gradients, or blurred colour glows.
3. Keep corners concentric and controls pill-shaped.
4. Colour needs a reason: status, the one primary action, or a chosen option.
5. Give every async action a loading state, and every failure the real message and a next step.
