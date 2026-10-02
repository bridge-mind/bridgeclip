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
| `accent` | `#1A5FDF` | Deep blue: primary buttons, chosen options, progress, focus ring |
| `--accent-button-hover` | `#286BE5` | Solid hover fill for primary buttons and editor trim handles |
| `accent-ink` | `#FFFFFF` | White text and icons on solid accent fills |
| `accent-cyan` | `#38CCFF` | The BridgeMind mark's blue |
| `success` · `warning` · `danger` | `#4ADE80` · `#FBBF24` · `#FF6B6E` | Status only |
| `brand.gold` | `#FFD500` | The virality score icon |

Every token supports alpha modifiers: `bg-accent/10`, `text-danger`. Don't use `from-`/`via-`/`to-` gradient stops.

Use the same `accent` blue for active navigation icons, selected options, progress and editor controls. Do not introduce a softer blue for active states. Use `accent-ink` for foregrounds on solid accent fills: `text-accent-ink` for text and icons, `bg-accent-ink` for switch thumbs. Keep buttons dark blue on hover so white labels stay legible. Keep buttons crisp with a subtle edge and no text shadow. Editor selections, crops and timeline controls use these same tokens rather than separate blues.

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
│ │  ◫ Chat          ⌘7              │
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
- Sticky elements inside a page use `top-0`; the scroll area's top padding already clears the 40px title-bar strip. Toolbars use `z-20`, below the title-bar strip (`z-30`); media cards isolate their overlay labels in their own stacking context.
- Wrap every page except Chat in `<Page width>`: `focus` 720 (progress, failure), `narrow` 880 (Settings, Accounts, Posts), `default` 1280 (Jobs, Captions), `wide` 1680 (Library, results). Create uses `narrow`. Gutters are `px-4`, `sm:px-6`, `xl:px-8`.
- **Compact by default.** Panels pad `p-4` (`xl:p-5`), stacks use `space-y-3`/`gap-3`, sections `mt-4`/`mt-5`. Don't reintroduce `p-6`+ or `mt-8`+. Media grids use `repeat(auto-fill, minmax(…))` so column count follows the window.
- **Create is a wizard**: Video → Format → Clips → Captions → Review, one compact panel per step under a clickable stepper, with Back/Next (and Generate) pinned to the bottom edge on a solid strip. Each new video starts with neither workflow selected. The illustrated Automatic (Beginner friendly) and Review & edit (For advanced users) cards require an explicit choice before continuing or submitting. ⌘↵ generates from any step once a video and workflow are chosen. After Generate the job is queued and the wizard offers "Clip another video", so several runs can be queued back to back. Step and draft live in `use-draft-store`.

---

### Editor surfaces

The editor uses scoped surface tokens in `components/clip-editor.css` to make its work areas distinct: near-black previews and timeline, neutral charcoal sidebars, and a dark transport strip. The timeline stays darker than the sidebars; avoid blue-gray or lighter slate fills. Hairline dividers reinforce these boundaries. Inputs and timeline lanes use recessed dark wells; blue remains the selection/action accent, with amber camera suggestions and lavender layout markers. Keep these colors scoped to the editor.

Compact editor actions use `Button`’s `tooltip` prop for short explanations on hover or keyboard focus. Include shortcuts where useful. Tooltips reuse `HoverCard`, stay above clipped panels, and do not introduce extra keyboard stops around buttons. Custom-tooltip buttons and wrappers explicitly use an empty native `title` to prevent inherited browser tooltips.

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
| `Badge`, `StatusDot` | Tinted glass pills, or solid blue with white text for `accent`; tones `neutral` · `accent` · `success` · `warning` · `danger`. Dots are solid and can pulse. |
| `IconTile` | A flat tinted tile holding an icon; `accent` uses solid blue with a white icon. Sizes `sm`–`xl`, same tones. |
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
- **Floating toolbars** (clip selection): `glass-thick` bar, sticky at `top-0 z-20`.
- **Captions lab** starts with a two-step wizard when the library is empty: choose a default base, then customize with a live preview. Once a custom preset exists, the page opens a preset table with a New preset action. Editing is a separate focused view. Preview and controls align at the top on desktop; compact layouts keep a smaller preview visible while the controls scroll. Default presets stay immutable; custom styles are saved copies. Create links to the lab and returns to the same draft. Caption pickers visibly separate Default from Your styles.
- **Review** reuses the source media card and groups the effective job settings into four editable glass tiles. Its caption sample uses the selected custom snapshot when present.
- **Caption previews** mirror the clipping engine presets in `engine/clip_engine/config.py` (colours, outline, glow, casing, spacing, box and karaoke effects). Motion previews preserve the portrait export's font-to-width ratio and side margins so larger word groups wrap within the video width, including on a wide desktop panel. Lines offers Auto, 1, 2 and 3; numbered choices balance groups across the selected rows (or fewer when there are fewer words), splitting groups sooner when needed to fit the width. Older presets default to Auto. The bundled voice sample and word timestamps share the media playback clock, including while muted. Sound is opt-in and remembered for the app session. If a preset changes in the engine, update `CaptionPresetPicker.tsx`.
- **Library bookmarks**: use a dedicated Bookmarked group above Recent runs, reverting to All runs when empty. Keep cards in one keyed grid so moving between groups preserves thumbnail nodes and focus. Bookmark updates are optimistic and local; failed saves restore the prior state. Overlay pending bookmarks on Library reloads and discard stale reads when a mutation completes. Explicit refreshes retry previews without clearing healthy thumbnails; bookmark-only changes do not reload previews. Animate positions with `useLibraryMotion` instead of fading the grid. Respect reduced motion and keep unbookmarked runs in their original chronological order.
- **Autosave**: Settings has no Save button. Keys save 600ms after typing stops and on blur, and paths save on blur or Enter. A "Saved" pill confirms it in the header.
- **Long work**: clipping runs in the main process's job queue (`src/main/job-manager.ts`): up to `MAX_PARALLEL_JOBS` (2) run at once and the rest wait in FIFO order. The Jobs page shows Active jobs (a small progress ring or queue position, stage, elapsed time, cancel) above Previous jobs (run history on disk, one line each: status dot, title, clips, run time, cost, date; the row opens the run, and the folder button shows on hover). Previous is paginated at ten jobs per page, with directional entry and height transitions; Active is never paginated. Search and filters operate before pagination, and reduced motion removes transitions. Opening a running job shows a compact Studio Timeline: every workflow stage has a progress bar, the active stage shows its current work, and a proportional time strip shows where processing time went. Unmeasured work stays indeterminate; older workers show an explicit measurement-unavailable state. Completed jobs open their clips; failures offer Run again. The sidebar shows a live count on Jobs and a card with the running jobs' progress.
- **Chat** (`pages/AssistantPage.tsx`) fills the page area instead of using `Page`, like a messaging app. A 248px **Chats** column (`components/assistant/ChatList.tsx`, flush with a hairline like the sidebar) lists recent chats grouped by day, each with its provider's logo, a spinner while it replies, an amber dot while it waits for approval, and a delete button on hover. It has a search field and a New chat button. Below 1024px the column folds into a history menu in the conversation header. A new chat is a centred hero: the chosen provider's logo, one question, the composer and starter chips (or a Connect card when nothing is connected). Once a chat starts, messages scroll in their own column (760px) above the composer, which docks to the bottom. User messages are right-aligned flat bubbles. Assistant replies open with the provider's logo tile and name plus the model that wrote that reply, then 14px body text. Runs of tool calls group into one `glass-tile` (spinner, check, cross or shield per row); three or more fold into one line once they've finished. Approval requests are `glass` cards with an amber rim, the details as plain lines, and one primary **Allow** beside a ghost **Don’t allow**. The composer is a `glass` card with an accent focus ring and a model chip (`ModelMenu`): a popover with a tab per provider (Claude, OpenAI, OpenRouter) under its logo, listing that provider's models as radios, with disconnected providers disabled and a Connect (or Add key) button. OpenRouter's tab is a search field over its tool-calling catalog, three suggestions first, with prices in Geist Mono. Replies render a small Markdown subset as React text, never HTML, and links are shown, not clickable.
- **Provider logos** (`components/brand/ProviderLogo.tsx`): Claude's spark in its own terracotta (`#D97757`), and OpenAI's blossom and OpenRouter's routing mark in `ink`, exactly as each company publishes them. They name whose model answers wherever the assistant appears (chat, model menu, Settings → Assistant). Use `variant="tile"` for a neutral glass lens and the bare glyph inline. Don't recolour them or use them for anything else.
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
- Keyboard: ⌘1–⌘7 and ⌘, switch pages (⌘7 is Chat), ⌘\ collapses or expands the sidebar, and ⌘↵ generates clips (Ctrl on Windows and Linux).

---

## Adding UI

1. Reach for `components/ui/` first. If you're writing the same class string twice, it belongs there.
2. Pick a material for every surface (`glass`, `glass-tile`, `glass-well`, `glass-thick`, `glass-chip`). Don't use raw greys, gradients, or blurred colour glows.
3. Keep corners concentric and controls pill-shaped.
4. Colour needs a reason: status, the one primary action, or a chosen option.
5. Give every async action a loading state, and every failure the real message and a next step.
