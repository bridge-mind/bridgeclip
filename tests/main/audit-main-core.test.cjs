const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const ts = require('typescript')

function loadSource(file, mocks = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => mocks[id] ?? require(id), URL, Set, Map, process, Buffer, console, setTimeout, clearTimeout, __dirname: path.join(__dirname, '../../src/main'), ...globals })
  return module.exports
}
function loadShared(file) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => id.startsWith('./') ? loadShared(`${id.slice(2)}.ts`) : require(id), URL })
  return module.exports
}

const security = loadSource('security.ts', { electron: {}, '../shared/brand': loadShared('brand.ts'), '../shared/jev-settings': loadShared('jev-settings.ts') })

/** ipc-handlers with a library at `library` and a shell that records what it is asked to open. */
function ipcWithLibrary(library) {
  const handlers = new Map()
  const opened = []
  const frame = {}
  const contents = { mainFrame: frame }
  const window = { webContents: contents, isDestroyed: () => false }
  const ipc = loadSource('ipc-handlers.ts', {
    electron: {
      app: { isPackaged: false },
      shell: { openPath: async (target) => { opened.push(target); return '' } },
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
      dialog: {}
    },
    './settings-store': { loadSettings: () => ({ outputDirectory: library }) },
    './file-manager': {},
    './run-history': {},
    './pipeline-runner': {},
    './job-manager': { initJobManager() {} },
    './job-start': {},
    './caption-library': {},
    './logger': {},
    './security': security,
    './network-policy': {},
    './validation': {},
    './openrouter-models': {},
    './tools': {},
    './zernio/service': {},
    './zernio/posts': {},
    './automations': {},
    './clip-editor': {},
    './output-storage': {},
    './edit-inspector': {},
    './youtube-preview': {},
    './library-posting': {},
    './library-management': {},
    './storage-cleanup': {}
  })
  ipc.registerIpcHandlers(() => window)
  const event = { sender: contents, senderFrame: frame }
  return { openPath: (target) => handlers.get('shell:openPath')(event, target), opened }
}

test('MAIN-1: shell opening rejects macOS package directories beyond .app/.bundle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-audit-packages-'))
  try {
    const library = path.join(root, 'library')
    fs.mkdirSync(library)
    const { openPath, opened } = ipcWithLibrary(library)
    // Each of these is a com.apple.package UTI: LaunchServices launches Installer,
    // System Settings, Automator or the bundle instead of revealing a folder.
    for (const name of ['installer.pkg', 'meta.mpkg', 'pane.prefPane', 'screen.saver', 'auto.workflow', 'act.action', 'svc.xpc', 'ext.appex', 'load.plugin', 'drv.kext', 'gen.qlgenerator', 'w.wdgt']) {
      const bundle = path.join(library, name)
      fs.mkdirSync(bundle)
      await assert.rejects(openPath(bundle), /Application bundles cannot be opened/, name)
      // Nested inside an ordinary run folder as well.
      const runDir = path.join(library, '11111111-2222-4333-8444-555555555555')
      fs.mkdirSync(runDir, { recursive: true })
      const nested = path.join(runDir, name)
      fs.mkdirSync(nested)
      await assert.rejects(openPath(nested), /Application bundles cannot be opened/, `nested ${name}`)
    }
    assert.deepEqual(opened, [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('MAIN-1: ordinary library folders, including dotted names, still open', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-audit-folders-'))
  try {
    const library = path.join(root, 'My.Clips')
    fs.mkdirSync(library)
    const runDir = path.join(library, '11111111-2222-4333-8444-555555555555')
    fs.mkdirSync(runDir)
    const { openPath, opened } = ipcWithLibrary(library)
    assert.equal(await openPath(runDir), true)
    assert.equal(await openPath(library), true)
    assert.deepEqual(opened, [fs.realpathSync(runDir), fs.realpathSync(library)])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
