// Export the imagegen master at native icon sizes. The artwork lives in
// resources/bridgeclip-icon.png; resizing never redraws or replaces the design.
// Run with Node via build-icons.sh (macOS sips is required).
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const source = path.resolve(__dirname, '../../resources/bridgeclip-icon.png')
const outDir = process.argv[2]
if (!outDir) throw new Error('Usage: node scripts/icon/render.js <output-directory>')

const master = fs.readFileSync(source)
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
if (master.length < 33 || !master.subarray(0, 8).equals(pngSignature)) {
  throw new Error('The app icon master must be a PNG')
}
const width = master.readUInt32BE(16)
const height = master.readUInt32BE(20)
if (width !== height || width < 1024) {
  throw new Error('The app icon master must be square and at least 1024px')
}

fs.mkdirSync(outDir, { recursive: true })
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  execFileSync('sips', ['-z', String(size), String(size), source, '--out', path.join(outDir, `icon-${size}.png`)], { stdio: 'ignore' })
}

// Self-contained raster-backed SVGs preserve the existing public asset URLs.
// They are generated exports, not editable vector masters.
for (const [name, size] of [['full', 1024], ['compact', 128]]) {
  const png = fs.readFileSync(path.join(outDir, `icon-${size}.png`)).toString('base64')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="BridgeClip">\n  <title>BridgeClip</title>\n  <image width="${size}" height="${size}" href="data:image/png;base64,${png}"/>\n</svg>\n`
  fs.writeFileSync(path.join(outDir, `${name}.svg`), svg)
}
console.log(`Exported app icon from ${width} × ${height} imagegen master`)
