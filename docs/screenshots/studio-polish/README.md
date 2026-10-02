# Studio UI review

These examples use synthetic videos, local test folders and mock provider metadata. No private media, provider keys or paid clipping runs are included.

The **before** images were captured from upstream `main` at `b996820`. The **after** images show this change on macOS. Automated checks also cover compact windows and reduced motion.

## Before and after

| Area | Before | After |
| --- | --- | --- |
| Create → Review | ![Original text summary](review-before.png) | ![Video preview and editable review cards](review-after.png) |
| Create → Captions | ![Original default caption picker](captions-before.png) | ![Caption picker with access to the lab](captions-after.png) |
| Jobs | ![Unpaginated Previous jobs](jobs-before.png) | ![Ten Previous jobs per page](jobs-after.png) |
| Library | ![Original Library cards](library-before.png) | ![Storage size on Library cards](library-after.png) |
| Delete a Library item | ![Original deletion confirmation](delete-before.png) | ![Space estimate and visual deletion summary](delete-after.png) |

## Captions lab

Choose a default as a starting point, then adjust your own preset with a live preview. This example arranges a caption group across two lines.

![Editing a custom caption preset with two lines](captions-lab.png)

Once presets are saved, the page opens with a table and a New preset action.

![Saved custom caption presets](captions-table.png)

## Pagination in motion

A short recording of moving between Previous pages, including the shorter final page.

![Animated Previous jobs pagination](jobs-pagination.gif)
