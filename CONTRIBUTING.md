# Contributing to BridgeClip

**Bug reports and focused bug-fix pull requests are welcome. Feature and other change pull requests require an explicit maintainer greenlight before implementation.** Unapproved feature or change PRs will be closed.

BridgeClip is open source and maintained by [@matthewmiller2925](https://github.com/matthewmiller2925), who reviews and merges every change and publishes official builds. Anyone can open a pull request from a fork.

## What we accept

| Contribution | Before opening a PR |
| --- | --- |
| Fix for a reproducible bug or regression | No prior feature approval is needed. Explain the failure, keep the fix focused, and include a regression test where appropriate. |
| New feature, integration, option or workflow | Get explicit maintainer approval for the proposed scope first. |
| Change to intended behavior, defaults, design or architecture | Get explicit maintainer approval first, including for substantial refactors and rewrites. |

A bug fix restores documented or clearly intended behavior. A preference for different behavior is a change proposal. Keep unrelated cleanup and new functionality out of bug-fix PRs. If the intended behavior is unclear, ask before implementing.

## Propose a change first

Open or find a relevant [issue](https://github.com/bridge-mind/bridgeclip/issues) and describe the problem, the proposed behavior and the scope of the change. Wait for an explicit comment from a primary maintainer approving that scope before starting implementation.

An open issue, a reaction or a discussion without a clear approval does not count as a greenlight. Link the approval in your PR. If the scope grows or the approach changes materially, get approval for the revised proposal first.

Approval means we are willing to consider the agreed change; it does not guarantee a merge. We still review correctness, design, maintenance cost and tests. A completed implementation does not override the contribution policy. You are free to explore other directions in a fork under the [MIT license](LICENSE).

## Report a bug

Search existing issues first. Include your BridgeClip version, operating system, steps to reproduce, and expected versus actual behavior. Add relevant logs or screenshots after removing keys and private source details. Report security vulnerabilities through [SECURITY.md](SECURITY.md).

## Set up

Follow the [development instructions](docs/development.md). Install the in-repo engine dependencies in `engine/.venv`, then run `npm ci` and `npm run dev`. Keep provider keys in the app's Settings; tests do not need real keys.

## Make a change

- Keep Electron main-process authority, preload IPC, renderer UI, and Python bridge responsibilities separate. Validate data at every IPC, subprocess, and saved-file boundary.
- Keep provider keys out of renderer state, logs, test fixtures, and issue reports. Use placeholders in examples.
- Update the README or architecture guide when setup, provider data flow, or supported behavior changes.
- Add a regression test for a bug or a new boundary. Avoid tests that only repeat implementation details.

Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` before submitting a code change. For engine changes, install `pytest` in `engine/.venv` and run `engine/.venv/bin/python -m pytest -q engine/tests`; the runtime lockfile does not include test tools. Describe behavior and test results in the PR. Include before/after screenshots for UI changes and a short recording when motion or interaction is needed to demonstrate the result.

Use imperative, scoped commit messages and pull request titles, such as `fix(clips): validate saved run output`. By contributing, you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Documentation changes

Keep the README focused on what BridgeClip does, installation, a first successful run, and links to help. Describe features by what users can do, with short bullets grouped by task. Add detailed controls and troubleshooting to the [user guide](docs/usage.md) or [editor guide](docs/editor.md), provider and storage details to [AI and privacy](docs/ai-and-privacy.md), and build instructions to [Development](docs/development.md).

Keep essential account, cost and data-sharing requirements visible in the README. Use relative links for repository files and release-page links for downloads. When behavior changes, update the relevant guide instead of appending a release summary to the README. Check that links, screenshots, defaults and platform claims match the current source; distinguish unreleased behavior from published builds.

## Changelog

[CHANGELOG.md](CHANGELOG.md) is bundled into the app and shown under **Settings → About → Changelog** and **Help → Changelog**, so write it for users.

- **Every user-visible change:** add a bullet under `## [Unreleased]` in the matching group: `### Added`, `### Changed`, `### Fixed` or `### Removed` (`Deprecated` and `Security` also work). Say what people can now do or what works better, and name the screen or setting. Leave out tests, CI, refactors and other internal changes. The app shows **bold** and `code`; links show as plain text.
- **Each release:** in the PR that bumps `package.json` and `package-lock.json` to `X.Y.Z`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and add an empty `## [Unreleased]` above it. At the bottom, point `[Unreleased]` at `compare/vX.Y.Z...HEAD` and add `[X.Y.Z]: https://github.com/bridge-mind/bridgeclip/releases/tag/vX.Y.Z`. Tag `vX.Y.Z` after the PR merges, and reuse the section as the GitHub Release notes.

`npm run test:release` fails when the `package.json` version has no dated section, versions are out of order, or a group isn't one of those types.

## Pull request descriptions

- Link the relevant issue and, for features or other changes, the maintainer's prior approval.
- Write every PR description as a concise, human-friendly list of changes in plain language. Avoid jargon and explain what people can now do or what works better.
- Cover all meaningful changes in the final PR, with one short bullet per change. Update the description as the scope changes; do not append a running work log.
- Focus on the result rather than file names, internal implementation details, or the order the work happened. Include technical details only when reviewers need them to understand a limitation or tradeoff.
- End with a brief testing note: what was checked, any known failures, and anything important that was not tested. Include screenshots or examples when they help explain a visible change.

Official CI logs and signing workflows are private. Build helpers, dependency pins, and release verification instructions remain available in this repository.
