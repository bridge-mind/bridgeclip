const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const bundle = buildSync({
  entryPoints: [path.join(root, 'src/shared/changelog.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false
}).outputFiles[0].text
const loaded = { exports: {} }
vm.runInThisContext(`(function (module, exports) {\n${bundle}\n})`)(loaded, loaded.exports)
const { CHANGELOG_CATEGORIES, UNRELEASED, hasChanges, parseChangelog, parseChangelogText } = loaded.exports

const markdown = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const releases = parseChangelog(markdown)
const released = releases.filter((release) => release.version !== UNRELEASED)
const semver = (value) => value.split('.').map(Number)
const compare = (a, b) => semver(a).reduce((order, part, index) => order || part - semver(b)[index], 0)

test('CHANGELOG.md starts with Unreleased and has a dated section for the package version', () => {
  assert.equal(releases[0]?.version, UNRELEASED, 'Keep an "## [Unreleased]" section at the top for the next release')
  assert.equal(releases.filter((release) => release.version === UNRELEASED).length, 1)
  const current = released.find((release) => release.version === version)
  assert.ok(current, `Add "## [${version}] - YYYY-MM-DD" to CHANGELOG.md: package.json is at ${version}`)
  assert.equal(released[0], current, `${version} must be the newest released section`)
  assert.ok(hasChanges(current), `CHANGELOG.md lists no changes for ${version}`)
})

test('CHANGELOG.md lists released versions newest first, each dated, with at least one change', () => {
  for (const release of released) {
    assert.match(release.version, /^\d+\.\d+\.\d+$/, `"${release.version}" is not a version number`)
    assert.match(release.date ?? '', /^\d{4}-\d{2}-\d{2}$/, `${release.version} needs a " - YYYY-MM-DD" release date`)
    assert.ok(hasChanges(release), `${release.version} lists no changes`)
  }
  for (let i = 1; i < released.length; i++) {
    const [newer, older] = [released[i - 1], released[i]]
    assert.ok(compare(newer.version, older.version) > 0, `${newer.version} must come before ${older.version}`)
    assert.ok(newer.date >= older.date, `${newer.version} is dated before ${older.version}`)
  }
})

test('CHANGELOG.md groups changes under Keep a Changelog types and links every version', () => {
  for (const release of releases) {
    for (const section of release.sections) {
      assert.ok(CHANGELOG_CATEGORIES.includes(section.heading), `${release.version}: use one of ${CHANGELOG_CATEGORIES.join(', ')}, not "${section.heading}"`)
    }
    assert.equal(new Set(release.sections.map((section) => section.heading)).size, release.sections.length, `${release.version} repeats a change type`)
    const escaped = release.version.replace(/\./g, '\\.')
    assert.match(markdown, new RegExp(`^\\[${escaped}\\]: https://github\\.com/bridge-mind/bridgeclip/\\S+$`, 'm'), `Add a link definition for [${release.version}] at the end of CHANGELOG.md`)
  }
})

test('the changelog parser reads releases, wrapped lines and change types as written', () => {
  const parsed = parseChangelog([
    '# Changelog',
    '',
    'Intro text is not a release.',
    '',
    '## [Unreleased]',
    '',
    '<!-- Add entries below.',
    '### Removed',
    '- hidden -->',
    '',
    '## [1.2.0] - 2026-10-01',
    'A short summary',
    'that wraps.',
    '',
    '### Added',
    '- **Bold** feature with `code`',
    '  that wraps onto a second line.',
    '* Another item',
    '',
    '### Fixed',
    '- A fix',
    '  - nested detail stays with its item',
    '',
    '[Unreleased]: https://example.com/compare',
    '[1.2.0]: https://example.com/1.2.0',
    '## Notes',
    'Not part of 1.2.0.'
  ].join('\r\n'))
  assert.deepEqual(parsed, [
    { version: 'Unreleased', date: null, notes: [], sections: [] },
    {
      version: '1.2.0',
      date: '2026-10-01',
      notes: ['A short summary that wraps.'],
      sections: [
        { heading: 'Added', items: ['**Bold** feature with `code` that wraps onto a second line.', 'Another item'] },
        { heading: 'Fixed', items: ['A fix - nested detail stays with its item'] }
      ]
    }
  ])
  assert.equal(hasChanges(parsed[0]), false)
  assert.equal(hasChanges(parsed[1]), true)
})

test('changelog text keeps bold and code, and shows links as their text only', () => {
  assert.deepEqual(parseChangelogText('Open **Settings → About**, run `npm test`, see [the docs](https://example.com/docs).'), [
    { kind: 'text', text: 'Open ' },
    { kind: 'strong', text: 'Settings → About' },
    { kind: 'text', text: ', run ' },
    { kind: 'code', text: 'npm test' },
    { kind: 'text', text: ', see the docs.' }
  ])
  assert.deepEqual(parseChangelogText('Plain'), [{ kind: 'text', text: 'Plain' }])
})
