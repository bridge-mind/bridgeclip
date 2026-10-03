const fs = require('node:fs')
const path = require('node:path')
const editorFixture = require('../fixtures/editor/project.json')

function storageRun(library, name, { count = 2, posted = [], editor = false, unfinished = false, sourceBytes = 2000, previewBytes = 500 } = {}) {
  const run = path.join(library, name)
  fs.mkdirSync(run, { recursive: true })
  const clips = Array.from({ length: count }, (_, index) => {
    const file = path.join(run, `clip_${String(index).padStart(2, '0')}.mp4`)
    fs.writeFileSync(file, Buffer.alloc(100 + index))
    fs.writeFileSync(file.replace('.mp4', '.srt'), 'captions')
    if (posted.includes(index)) fs.writeFileSync(path.join(run, `.bridgeclip-posted-${index}`), '')
    return { clip_index: index, s3_url: file, summary: `${name} clip ${index + 1}`, duration_ms: 1000, start_time_ms: 0, end_time_ms: 1000, virality_score: 0.8 }
  })
  const output = { source_video_title: name, clips, total_clips: clips.length, ...(editor ? { editor_project: true } : {}) }
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify(output))
  let project
  if (editor) {
    project = structuredClone(editorFixture)
    project.title = name
    project.candidates.forEach((candidate, i) => { candidate.status = unfinished && i === 1 ? 'ready' : 'baked'; candidate.exports = clips[i] ? [i] : [] })
    fs.writeFileSync(path.join(run, 'editor-project.json'), JSON.stringify(project))
    fs.writeFileSync(path.join(run, 'editor-source.mp4'), Buffer.alloc(sourceBytes))
    fs.writeFileSync(path.join(run, 'editor-preview.mp4'), Buffer.alloc(previewBytes))
  }
  return { run, clips, project }
}
module.exports = { storageRun }
