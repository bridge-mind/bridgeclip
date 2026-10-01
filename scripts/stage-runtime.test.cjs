'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const STAGE_SCRIPT = path.join(__dirname, 'release/stage-runtime.py')
const toolsAvailable = ['gcc', 'patchelf', 'python3'].every((tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0)
const skip = process.platform !== 'linux' || !toolsAvailable ? 'Linux with gcc, patchelf and python3 is required' : false

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}`)
  return result.stdout
}

function copySharedLibraries(source, destination) {
  return spawnSync('python3', ['-c', `
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("stage_runtime", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.copy_shared_libraries(Path(sys.argv[2]), Path(sys.argv[3]))
`, STAGE_SCRIPT, source, destination], { encoding: 'utf8' })
}

/** Build libNAME.so.MAJOR.MINOR.PATCH with the symlink chain upstream archives ship. */
function versionedLibrary(directory, name, major, symbol) {
  const real = `lib${name}.so.${major}.4.103`
  const source = path.join(directory, `${name}.c`)
  fs.writeFileSync(source, `int ${symbol}(void) { return ${major}; }\n`)
  run('gcc', ['-shared', '-fPIC', `-Wl,-soname,lib${name}.so.${major}`, '-o', path.join(directory, real), source])
  fs.rmSync(source)
  fs.symlinkSync(real, path.join(directory, `lib${name}.so.${major}`))
  fs.symlinkSync(`lib${name}.so.${major}`, path.join(directory, `lib${name}.so`))
  return real
}

test('shared libraries are staged once under the SONAME the loader requests', { skip }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-stage-libs-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'archive-lib'), staged = path.join(root, 'engine-bin')
  fs.mkdirSync(source)
  fs.mkdirSync(staged)
  fs.mkdirSync(path.join(source, 'pkgconfig'))
  fs.writeFileSync(path.join(source, 'pkgconfig', 'libavcodec.pc'), 'Name: fixture\n')
  const codec = versionedLibrary(source, 'avcodec', 62, 'codec_major')
  versionedLibrary(source, 'avutil', 60, 'util_major')

  const result = copySharedLibraries(source, path.join(staged, 'lib'))
  assert.equal(result.status, 0, result.stderr)
  const files = fs.readdirSync(path.join(staged, 'lib')).sort()
  assert.deepEqual(files, ['libavcodec.so.62', 'libavutil.so.60'])
  for (const file of files) assert.equal(fs.lstatSync(path.join(staged, 'lib', file)).isFile(), true)
  assert.equal(fs.statSync(path.join(staged, 'lib', 'libavcodec.so.62')).size, fs.statSync(path.join(source, codec)).size)

  // A program linked like ffmpeg must still load both libraries from $ORIGIN/lib.
  const program = path.join(root, 'program.c')
  fs.writeFileSync(program, 'int codec_major(void); int util_major(void);\nint main(void) { return codec_major() == 62 && util_major() == 60 ? 0 : 1; }\n')
  run('gcc', ['-o', path.join(staged, 'probe'), program, `-L${source}`, '-lavcodec', '-lavutil', "-Wl,-rpath,$ORIGIN/lib"])
  run(path.join(staged, 'probe'), [], { env: { PATH: '/usr/bin:/bin' } })
})

test('a library without a SONAME stops staging instead of shipping an unloadable name', { skip }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-stage-libs-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'archive-lib')
  fs.mkdirSync(source)
  const code = path.join(root, 'plain.c')
  fs.writeFileSync(code, 'int plain(void) { return 1; }\n')
  run('gcc', ['-shared', '-fPIC', '-o', path.join(source, 'libplain.so.1'), code])
  const result = copySharedLibraries(source, path.join(root, 'lib'))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Shared library has no usable SONAME: libplain\.so\.1/)
})
