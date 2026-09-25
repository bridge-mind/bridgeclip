# Contributing to BridgeClip

BridgeClip is open source and maintained by [@matthewmiller2925](https://github.com/matthewmiller2925). Only the maintainer contributes changes to this repository and publishes official builds. Pull requests are restricted to collaborators; community bug reports and feature requests are welcome through Issues. The MIT license still permits anyone to use, modify, and fork the source.

## Set up

Follow the [development instructions](README.md#develop). Install the in-repo engine dependencies in `engine/.venv`, then run `npm ci` and `npm run dev`. Keep provider keys in the app's Settings; tests do not need real keys.

## Make a change

- Keep Electron main-process authority, preload IPC, renderer UI, and Python bridge responsibilities separate. Validate data at every IPC, subprocess, and saved-file boundary.
- Keep provider keys out of renderer state, logs, test fixtures, and issue reports. Use placeholders in examples.
- Update the README or architecture guide when setup, provider data flow, or supported behavior changes.
- Add a regression test for a bug or a new boundary. Avoid tests that only repeat implementation details.

Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` when working on a local fork. For engine changes, install `pytest` in `engine/.venv` and run `engine/.venv/bin/python -m pytest -q engine/tests`; the runtime lockfile does not include test tools. Describe behavior, tests, and any user-visible screenshots or sample outputs in the PR.

Use an imperative, scoped commit message such as `fix(clips): validate saved run output`. By contributing, you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).

Official CI logs and signing workflows are private. Build helpers, dependency pins, and release verification instructions remain available in this repository.
