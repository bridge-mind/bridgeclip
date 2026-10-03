# Studio UI review

These examples use synthetic videos, local test folders and mock provider metadata. No private media, provider keys or paid clipping runs are included.

The **before** images were captured from upstream `main` at `b996820`, except the caption editor comparison at `e09c091`, caption browser at `0a09f2d`, and Library details at `6dc143a`, all from earlier versions of this draft PR. The **after** images show this change on macOS. Automated checks also cover compact windows and reduced motion.

## Before and after

| Area | Before | After |
| --- | --- | --- |
| Create → Review | ![Original text summary](review-before.png) | ![Video preview and editable review cards](review-after.png) |
| Create → Captions | ![Original default caption picker](captions-before.png) | ![Caption picker with access to the lab](captions-after.png) |
| Jobs | ![Unpaginated Previous jobs](jobs-before.png) | ![Previous jobs with a page-size selector](jobs-after.png) |
| Library | ![Original Library cards](library-before.png) | ![Storage size on Library cards](library-after.png) |
| Library item details | ![Earlier details with visible advanced tools](library-details-before.png) | ![Source card beside a 2×2 stats grid and compact clip controls](library-details-after.png) |
| Delete a Library item | ![Original deletion confirmation](delete-before.png) | ![Space estimate and visual deletion summary](delete-after.png) |
| Settings → Content storage | ![Original storage total](storage-before.png) | ![Cleanup controls and source storage breakdown](storage-after.png) |
| Captions editor | ![Earlier draft with repeated preview labels](captions-editor-before.png) | ![Simplified preview and separate padding controls](captions-lab.png) |
| Caption browser | ![Table above defaults and a separate preview on the right](captions-browse-before.png) | ![Custom and default presets share a preview on the left](captions-cards.png) |
| Posts | ![Ten recent posts and Show all](posts-before.png) | ![Numbered pages with a shared page-size preference](posts-after.png) |

## Storage cleanup

Review published clips and the estimated space they occupy before removing local copies. Fully posted, finished projects can be removed together; mixed projects keep their unposted clips and unfinished edits.

![Select published content to clean](published-cleanup.png)

Review & edit users also see retained source videos and editor previews. Select finished projects to free their media while keeping exports; projects with clips still to finish stay protected. Automatic-only libraries do not show this source section.

![Select finished source media while protecting unfinished projects](source-cleanup.png)

## Captions lab

Choose a default as a starting point, then adjust your own preset with a live preview. Switch between short and long voice samples, or select a caption line to jump to it. This example shows two balanced lines with separate horizontal and vertical background padding.

![Editing a custom caption preset with two lines](captions-lab.png)

Once presets are saved, the page opens with matching three-column card grids and a New preset action. Select a custom preset card to preview it without opening an edit; its **…** menu offers edit, duplicate and delete. Default styles remain below Your presets, and both use the same preview on the left. Edit swaps the list for controls without moving or resizing that preview.

![Custom presets and default styles with bookmarks](captions-cards.png)

![The same preset preview stays in position while editing](captions-edit-position.png)

Bookmarks move smoothly to the front of their existing list without changing the preview or losing keyboard focus. The bookmark icon also follows its card's hover lift. Reduced motion skips these movements.

![Bookmarking Paper moves its card to the front](captions-bookmark-motion.gif)

Previews on the Captions page open paused with sample text visible, even with sound enabled. Play starts the recording; switching styles or reopening the page returns to a still preview.

![Captions visible at the paused opening frame](captions-paused.png)

In Create and the clip editor, **Favorites** filters the picker to your bookmarks while keeping default and custom styles separate. Bookmarks are retained across app launches. New clip setups select the first available bookmark in picker order, or Pop when there are none; explicit choices stay selected.

![Favorite caption styles in Create](captions-favorites.png)

Saving keeps the editor open. Leaving unsaved changes offers save, discard and cancel; reload and app close also ask whether to save.

![Save caption changes before navigating away](caption-save-prompt.png)

## Library item details

The source card and a compact 2×2 grid of run statistics share the top row equally, with saved metadata available immediately. The panels stack in smaller windows. Search, sorting and selection share one toolbar; selecting clips reveals the bulk actions. Continue editing remains a primary action. The **…** menu holds transcript inspection, processing details, folder access and post-status refresh. Editorial weights appear only when using Editorial sorting.

Run statistics stay visible beside the source; the Processing details dialog contains stage timings and model usage. Keyboard checks cover opening the menu, focus inside the dialog and returning to the menu trigger. Compact-window checks include selection and bulk actions; older runs and unavailable local sources still show their saved title and duration.

![Processing details opened from the menu](library-processing-details.png)

## Dismissed posting activity

Clearing finished updates from Posts keeps the clip in the Library’s Posted group. These two screens show the same synthetic clip after dismissing its activity and reloading; its online post and cleanup eligibility are also preserved.

| Posts after dismissal | Library after dismissal |
| --- | --- |
| ![Cleared posting activity](posts-dismissed.png) | ![Clip remains in the Posted group](posts-library-status.png) |

## Crash reports

Settings → About lets users review and copy the latest local report, then add reproduction steps to a GitHub issue. The report contains safe diagnostics and recent event names; it excludes keys, paths, URLs and raw error messages. This example uses a simulated interface error.

![Review and copy a crash issue report](crash-report.png)

## Pagination in motion

A short recording of moving between Previous pages, including the shorter final page, then changing the count from 10 to 25 and back. The app remembers the selected count across navigation and restarts.

![Animated Previous jobs pagination](jobs-pagination.gif)
