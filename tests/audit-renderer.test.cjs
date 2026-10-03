// Renderer security regressions: untrusted data (saved run files, LLM titles,
// Zernio responses, pasted links) must never reach a dangerous sink in the
// sandboxed renderer. Run with: node --test tests/audit-renderer.test.cjs
const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { buildSync } = require('esbuild')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const bundled = buildSync({
  stdin: {
    contents: `export { localFileUrl, youtubeId, sourceLabel, errorMessage } from './src/renderer/lib/utils';
      export { clipFilePath } from './src/renderer/lib/thumbnails';
      export { SourcePicker } from './src/renderer/components/SourcePicker';
      export { ClipList } from './src/renderer/components/ClipList';
      export { PostsPage } from './src/renderer/pages/PostsPage';
      export { AccountsPage } from './src/renderer/pages/AccountsPage';
      export { SettingsPage } from './src/renderer/pages/SettingsPage';
      export { usePostsStore } from './src/renderer/store/use-posts-store';
      export { useAccountsStore } from './src/renderer/store/use-accounts-store';
      export { useSettingsStore } from './src/renderer/store/use-settings-store';
      export { parseJobOutput } from './src/shared/job-output';`,
    resolveDir: path.resolve(__dirname, '..'),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  loader: { '.svg': 'dataurl', '.css': 'empty', '.mp3': 'dataurl' },
  define: { __APP_VERSION__: JSON.stringify(require('../package.json').version) },
  jsx: 'automatic',
  write: false
}).outputFiles[0].text

// Static rendering never runs effects, so the IPC surface only has to exist.
const calls = []
const record = (name) => (...args) => { calls.push([name, ...args]); return new Promise(() => {}) }
globalThis.window = {
  bridgeclip: {
    settings: { load: record('settings.load'), save: record('settings.save'), replaceApiKey: record('settings.replaceApiKey') },
    shell: { openPath: record('shell.openPath'), showItemInFolder: record('shell.showItemInFolder') },
    thumbnails: { generate: record('thumbnails.generate') },
    zernio: { posts: { open: record('posts.open'), probe: record('posts.probe') }, onConnectResult: () => () => {}, onReset: () => () => {} },
    system: { isPackaged: record('system.isPackaged') }
  }
}
const mod = { exports: {} }
new Function('module', 'exports', 'require', bundled)(mod, mod.exports, require)
const {
  localFileUrl, youtubeId, sourceLabel, errorMessage, clipFilePath, SourcePicker, ClipList, PostsPage, AccountsPage, SettingsPage,
  usePostsStore, useAccountsStore, useSettingsStore, parseJobOutput
} = mod.exports

const HOSTILE_TEXT = '<img src=x onerror=alert(1)>"onmouseover="alert(2)'
const HOSTILE_SCRIPT = '</span><script>alert(3)</script>'

/**
 * Static rendering asks stores for their *server* snapshot, which zustand v5
 * wires to the store's initial state, so `setState` would be invisible. For
 * these renders the current state is the one under test.
 */
function render(element) {
  const original = React.useSyncExternalStore
  React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot()
  try {
    return renderToStaticMarkup(element)
  } finally {
    React.useSyncExternalStore = original
  }
}

function unescapeAttr(value) {
  return value.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** Every element React emitted, with its attributes. React always quotes values and escapes `<>"&` in them. */
function tags(html) {
  return [...html.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>/g)].map((match) => ({
    name: match[1].toLowerCase(),
    attrs: new Map([...match[2].matchAll(/\s+([^\s=>/]+)(?:="([^"]*)")?/g)].map((attr) => [attr[1].toLowerCase(), unescapeAttr(attr[2] ?? '')]))
  }))
}

function attributes(html, name) {
  return tags(html).filter((tag) => tag.attrs.has(name)).map((tag) => tag.attrs.get(name))
}

const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'a', 'form', 'base', 'meta', 'style'])
const URL_ATTRS = new Set(['src', 'srcset', 'poster', 'href', 'action', 'formaction', 'data', 'xlink:href'])
/** Media may come from the main process's local-file protocol, the YouTube thumbnail host, or bundled brand SVGs. */
const ALLOWED_URL = /^(local-file:\/\/media\/[^/?#:\\]*$|https:\/\/i\.ytimg\.com\/|data:image\/svg\+xml)/

/** Hostile strings must end up as text: no injected elements, handlers or URLs anywhere in the markup. */
function assertEscaped(html) {
  assert.doesNotMatch(html, /<script/i, 'script tags must be escaped')
  for (const { name, attrs } of tags(html)) {
    assert.ok(!FORBIDDEN_TAGS.has(name), `no <${name}> element may be rendered`)
    // React's static renderer adds an SSR-only preload hint per <img src>; nothing else may carry a URL attribute.
    if (name === 'link') assert.equal(attrs.get('rel'), 'preload', 'only React preload hints')
    for (const [attr, value] of attrs) {
      assert.doesNotMatch(attr, /^on/, `no inline event handler (${attr})`)
      if (URL_ATTRS.has(attr)) {
        assert.match(value, ALLOWED_URL, `<${name} ${attr}> must be local-file://media/ or the YouTube thumbnail host: ${value}`)
        if (value.startsWith('https://')) assert.equal(new URL(value).hostname, 'i.ytimg.com')
      }
    }
  }
}

test('the escape checks themselves reject injected anchors, handlers, scripts and remote media', () => {
  assert.throws(() => assertEscaped('<p><a href="javascript:alert(1)">x</a></p>'), /no <a> element/)
  assert.throws(() => assertEscaped('<button onclick="alert(1)">x</button>'), /no inline event handler/)
  assert.throws(() => assertEscaped('<div><script>alert(1)</script></div>'), /script tags/)
  assert.throws(() => assertEscaped('<img src="https://evil.example/x.png"/>'), /must be local-file/)
  assert.throws(() => assertEscaped('<video src="javascript:alert(1)"></video>'), /must be local-file/)
  assert.throws(() => assertEscaped('<video src="local-file://media/%2Fclips%2Fa.mp4" poster="file:///etc/passwd"></video>'), /must be local-file/)
  assert.throws(() => assertEscaped('<link rel="stylesheet" href="https://evil.example/x.css"/>'), /preload/)
  assertEscaped('<p title="&lt;img src=x onerror=alert(1)&gt;">&lt;script&gt;x&lt;/script&gt; onerror=y</p><img src="local-file://media/%2Fa.jpg"/>')
})

test('local-file URLs percent-encode the whole path, so a run file cannot smuggle a scheme, query or fragment', () => {
  assert.equal(localFileUrl('/clips/run/clip 1.mp4'), 'local-file://media/%2Fclips%2Frun%2Fclip%201.mp4')
  assert.equal(localFileUrl('javascript:alert(1)'), 'local-file://media/javascript%3Aalert(1)')
  assert.equal(localFileUrl('/a/b?x=1#frag'), 'local-file://media/%2Fa%2Fb%3Fx%3D1%23frag')
  for (const hostile of ['javascript:alert(1)', 'file:///etc/passwd', 'https://evil.example/x', 'C:\\Windows\\..\\evil']) {
    const url = localFileUrl(hostile)
    assert.ok(url.startsWith('local-file://media/'), url)
    assert.doesNotMatch(url.slice('local-file://media/'.length), /[/?#:\\]/, 'every reserved character is encoded')
  }
})

test('clip paths from run files only drop the file:// prefix and are never decoded', () => {
  assert.equal(clipFilePath('file:///clips/run/clip.mp4'), '/clips/run/clip.mp4')
  assert.equal(clipFilePath('/clips/run/clip.mp4'), '/clips/run/clip.mp4')
  assert.equal(clipFilePath('file:///clips/%2e%2e/secret.mp4'), '/clips/%2e%2e/secret.mp4')
  assert.equal(clipFilePath('https://evil.example/clip.mp4'), 'https://evil.example/clip.mp4')
})

test('the renderer settings state never retains raw API keys, even if the main process returned them', async () => {
  const leak = { openrouterApiKey: 'sk-or-SECRET', zernioApiKey: 'sk_SECRET' }
  const settings = { openrouterConfigured: true, zernioConfigured: true, outputDirectory: '/clips', pythonPath: 'python3', customVocabulary: '', ...leak }
  window.bridgeclip.settings.load = async () => settings
  window.bridgeclip.settings.save = async () => settings
  window.bridgeclip.settings.replaceApiKey = async () => settings
  await useSettingsStore.getState().load()
  await useSettingsStore.getState().save({ customVocabulary: 'x' })
  await useSettingsStore.getState().replaceApiKey('openrouterApiKey', 'sk-or-typed')
  const state = JSON.stringify(useSettingsStore.getState())
  assert.doesNotMatch(state, /SECRET|sk-or-typed/, 'state holds configured flags only')
  assert.equal(useSettingsStore.getState().openrouterConfigured, true)
})

test('the settings page shows a configured key as a masked, empty field rather than the stored value', () => {
  useSettingsStore.setState({ openrouterConfigured: true, zernioConfigured: true, loaded: true, outputDirectory: '/clips' })
  const html = render(React.createElement(SettingsPage))
  assert.match(html, /Saved securely\. Paste a new key to replace\./)
  assert.doesNotMatch(html, /sk-or-|sk_SECRET|SECRET/)
  const inputs = [...html.matchAll(/<input[^>]*>/g)].map((match) => match[0]).filter((input) => /type="password"/.test(input))
  assert.equal(inputs.length, 2, 'both key inputs are password fields until the user reveals their own draft')
  for (const input of inputs) assert.match(input, /value=""/)
  assertEscaped(html)
})

test('a pasted YouTube link only ever loads its thumbnail from i.ytimg.com, whatever the video id contains', () => {
  const links = [
    `https://www.youtube.com/watch?v=${encodeURIComponent('abc"><img src=x onerror=alert(1)>')}`,
    'https://www.youtube.com/watch?v=..%2F..%2Fevil.example%2Fx',
    'https://www.youtube.com/watch?v=%2F%2Fevil.example%2Fx',
    'https://youtu.be/abc@evil.example',
    'https://www.youtube.com/shorts/abc%3Fx%23y'
  ]
  for (const link of links) {
    assert.ok(youtubeId(link), link)
    const html = render(React.createElement(SourcePicker, { value: link, onChange() {} }))
    const sources = attributes(html, 'src')
    assert.equal(sources.length, 1, `one thumbnail for ${link}`)
    const url = new URL(sources[0])
    assert.equal(url.protocol, 'https:')
    assert.equal(url.hostname, 'i.ytimg.com')
    assertEscaped(html)
  }
})

test('a non-YouTube link renders no remote media at all, and a local source only a local-file://media/ video', () => {
  const remote = render(React.createElement(SourcePicker, { value: 'https://cdn.example/video.mp4?cb=<img src=x onerror=alert(1)>', onChange() {} }))
  assert.deepEqual(attributes(remote, 'src'), [])
  assertEscaped(remote)

  const local = render(React.createElement(SourcePicker, { value: 'javascript:alert(1)', onChange() {} }))
  assert.deepEqual(attributes(local, 'src'), ['local-file://media/javascript%3Aalert(1)'])
  assertEscaped(local)
})

test('a hostile saved run renders escaped titles and never an anchor, script or javascript: URL', () => {
  const output = parseJobOutput({
    job_id: 'job',
    source_video_title: `Title ${HOSTILE_TEXT}${HOSTILE_SCRIPT}`,
    clips: [
      { clip_index: 0, s3_url: 'javascript:alert(1)', duration_ms: 1000, start_time_ms: 0, end_time_ms: 1000, virality_score: 0.9, summary: HOSTILE_TEXT, tags: [HOSTILE_SCRIPT] },
      { clip_index: 1, s3_url: 'file:///clips/run/<script>alert(1)</script>.mp4', duration_ms: 1000, start_time_ms: 0, end_time_ms: 1000, virality_score: 0.5, summary: HOSTILE_SCRIPT, tags: [] }
    ],
    metrics: { api_costs: { total_estimated_cost_usd: 0.01, planning: { model: HOSTILE_SCRIPT, estimated_cost_usd: 0.01 } } }
  })
  assert.ok(output)
  const html = render(React.createElement(ClipList, { output, outputDir: '/clips/run' }))
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/)
  assertEscaped(html)
  assert.equal(calls.filter(([name]) => name.startsWith('shell.')).length, 0, 'rendering opens nothing')
})

test('post links and Zernio error text render as escaped text and open only through the main process', () => {
  const post = {
    id: 'post1',
    clipPath: '/clips/run/clip.mp4',
    clipTitle: HOSTILE_TEXT,
    targets: [
      { platform: 'tiktok', accountId: 'a1', handle: `@${HOSTILE_SCRIPT}`, status: 'published', error: null, url: 'javascript:alert(1)', inbox: false },
      { platform: `constructor${HOSTILE_TEXT}`, accountId: 'a2', handle: null, status: 'failed', error: `Zernio said ${HOSTILE_SCRIPT}`, url: 'https://evil.example/"onclick="alert(1)', inbox: false }
    ],
    scheduledFor: null, timezone: null, status: 'partial', error: HOSTILE_SCRIPT,
    createdAt: '2026-09-24T10:00:00.000Z', uploadedAt: '2026-09-24T10:00:00.000Z', refreshedAt: null
  }
  useSettingsStore.setState({ zernioConfigured: true })
  usePostsStore.setState({ posts: [post], loaded: true, error: HOSTILE_SCRIPT })
  const html = render(React.createElement(PostsPage, { onNavigate() {} }))
  assert.equal([...html.matchAll(/title="Open on /g)].length, 2, 'each target with a link gets an open button')
  assert.match(html, /Zernio said &lt;\/span&gt;&lt;script&gt;/)
  assertEscaped(html)
  assert.deepEqual(attributes(html, 'src'), [], 'no remote images: thumbnails come from the main process later')
})

test('hostile Zernio account data (names, platforms, error text) renders escaped and without crashing', () => {
  const account = (id, platform, extra = {}) => ({
    id, platform, username: HOSTILE_TEXT, displayName: HOSTILE_SCRIPT, profileId: 'p1', isActive: true, health: 'warning',
    needsReconnect: false, issue: `Issue ${HOSTILE_SCRIPT}`, ...extra
  })
  useSettingsStore.setState({ zernioConfigured: true })
  useAccountsStore.setState({
    profiles: [{ id: 'p1', name: `Profile ${HOSTILE_TEXT}`, isDefault: true }],
    accounts: [account('a1', 'tiktok'), account('a2', 'constructor'), account('a3', '__proto__', { needsReconnect: true })],
    profileId: 'p1', syncedAt: Date.now(), loaded: true, loading: false,
    error: { message: `Zernio error ${HOSTILE_SCRIPT}`, kind: 'other' },
    notice: { tone: 'danger', text: `Notice ${HOSTILE_SCRIPT}`, action: 'billing' }
  })
  const html = render(React.createElement(AccountsPage, { onNavigate() {} }))
  assert.match(html, /Notice &lt;\/span&gt;&lt;script&gt;/)
  assert.match(html, /Zernio error &lt;\/span&gt;/)
  assertEscaped(html)
  assert.deepEqual(attributes(html, 'src'), [], 'account tiles never load remote avatars')
})

test('source labels and IPC error messages are plain text derived from the URL parser', () => {
  assert.equal(sourceLabel(`https://www.youtube.com/watch?v=${encodeURIComponent('<b>x</b>')}`), 'youtube.com/watch?v=%3Cb%3Ex%3C%2Fb%3E')
  assert.equal(errorMessage(new Error(`Error invoking remote method 'shell:openPath': Error: ${HOSTILE_SCRIPT}`)), HOSTILE_SCRIPT)
  assert.equal(errorMessage({ toString: () => 'evil' }, 'fallback'), 'fallback')
})
