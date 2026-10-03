# Studio UI review

These examples use synthetic videos, local test folders and mock provider metadata. No private media, provider keys or paid clipping runs are included.

The **before** images were captured from upstream `main` at `b996820`. The **after** images show this change on macOS. Automated checks also cover compact windows and reduced motion.

## Before and after

| Area | Before | After |
| --- | --- | --- |
| Create → Review | ![Original text summary](review-before.png) | ![Video preview and editable review cards](review-after.png) |
| Create → Captions | ![Original default caption picker](captions-before.png) | ![Caption picker with access to the lab](captions-after.png) |
| Jobs | ![Unpaginated Previous jobs](jobs-before.png) | ![Previous jobs with a page-size selector](jobs-after.png) |
| Library | ![Original Library cards](library-before.png) | ![Storage size on Library cards](library-after.png) |
| Delete a Library item | ![Original deletion confirmation](delete-before.png) | ![Space estimate and visual deletion summary](delete-after.png) |
| Settings → Content storage | ![Original storage total](storage-before.png) | ![Cleanup controls and source storage breakdown](storage-after.png) |

## Storage cleanup

Review published clips and the estimated space they occupy before removing local copies. Fully posted, finished projects can be removed together; mixed projects keep their unposted clips and unfinished edits.

![Select published content to clean](published-cleanup.png)

Review & edit users also see retained source videos and editor previews. Select finished projects to free their media while keeping exports; projects with clips still to finish stay protected. Automatic-only libraries do not show this source section.

![Select finished source media while protecting unfinished projects](source-cleanup.png)

## Captions lab

Choose a default as a starting point, then adjust your own preset with a live preview. Switch between short and long voice samples, or select a caption line to jump to it. This example shows two balanced lines from the longer sample.

![Editing a custom caption preset with two lines](captions-lab.png)

Once presets are saved, the page opens with a table and a New preset action.

![Saved custom caption presets](captions-table.png)

## Pagination in motion

A short recording of moving between Previous pages, including the shorter final page, then changing the count from 10 to 25 and back. The app remembers the selected count across navigation and restarts.

![Animated Previous jobs pagination](jobs-pagination.gif)
