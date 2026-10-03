"""Review-first projects: suggestions and Jev advice, then exact human-directed exports."""
import asyncio
import json
import math
import os
import re
import tempfile
from contextlib import contextmanager
from uuid import uuid4
from datetime import datetime, timezone
from dataclasses import replace
from pathlib import Path
from clip_engine.error_policy import NoClipCandidatesError

from clip_engine.services.coherence_review import CLIP_QUESTIONS, CUT_QUESTIONS, CoherenceReviewer, check_threshold, dialogue
from clip_engine.services.jev_service import JevService
from clip_engine.services.layout_analyzer import ClipLayoutPlan, ShotLayout, LayoutType
from clip_engine.services.layout_renderer import shot_views
from clip_engine.services.rendering_service import RenderRequest, RenderingService
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord
from clip_engine.services.media_process import MEDIA_INPUT_OPTIONS, PROBE_TIMEOUT_SECONDS, run_media, validate_video_dimensions


# Fixed failure codes; the only failure detail that crosses the bridge.
EDITOR_ERROR_CODES = frozenset({'duration', 'geometry', 'audio', 'invalid', 'project_changed', 'invalid_edit', 'not_ready',
    'source_missing', 'source_incompatible', 'render_failed', 'scan_too_long', 'review_unavailable', 'engine_unavailable'})


class EditorError(ValueError):
    def __init__(self, code, message=None):
        self.editor_code = code
        super().__init__(message or code)


class SourceReplacementError(EditorError):
    def __init__(self, code):
        self.code = code
        super().__init__(code, 'Source replacement rejected')


@contextmanager
def failure_code(code):
    """Label failures without changing their type or message."""
    try:
        yield
    except Exception as error:
        if getattr(error, 'editor_code', None) not in EDITOR_ERROR_CODES:
            try:
                error.editor_code = code
            except AttributeError:
                pass
        raise


def utf16_prefix(text, limit):
    """At most `limit` UTF-16 units (the editor UI's string length), never half a surrogate pair."""
    units = 0
    for i, char in enumerate(text):
        units += 2 if ord(char) > 0xFFFF else 1
        if units > limit:
            return text[:i]
    return text


def media_name(kind, source_id=None):
    if source_id is not None and (not isinstance(source_id, str) or not re.fullmatch(r'[a-f0-9]{32}', source_id)):
        raise ValueError('Invalid source generation')
    return f'editor-{kind}{"-" + source_id if source_id else ""}.mp4'


def source_info(path):
    try:
        result = run_media(['ffprobe', '-v', 'error', *MEDIA_INPUT_OPTIONS, '-show_streams', '-show_format',
                            '-of', 'json', str(path)], timeout=PROBE_TIMEOUT_SECONDS, check=True)
        data = json.loads(result.stdout)
        video = next(s for s in data['streams'] if s['codec_type'] == 'video')
        width, height = int(video['width']), int(video['height'])
        validate_video_dimensions(width, height)
        if min(width, height) < 2:
            raise ValueError('Invalid editor dimensions')
        duration = float(video.get('duration', data['format'].get('duration', 0))) * 1000
        if not math.isfinite(duration) or duration < 100:
            raise ValueError('Invalid duration')
        rotation = next((s['rotation'] for s in video.get('side_data_list', []) if 'rotation' in s), 0)
        return {'width': width, 'height': height, 'duration': duration, 'rotation': rotation,
                'sar': video.get('sample_aspect_ratio') if video.get('sample_aspect_ratio') not in (None, 'N/A', '0:1') else '1:1',
                'audio': any(s['codec_type'] == 'audio' for s in data['streams'])}
    except Exception as error:
        raise SourceReplacementError('invalid') from error


async def replace_source(run, project, source_id):
    """Prepare immutable media, then switch the project's pointer in one atomic write."""
    source = local_file(run, media_name('source', source_id))
    original = local_file(run, media_name('source', project.get('source_id')))
    old, new = await asyncio.gather(asyncio.to_thread(source_info, original), asyncio.to_thread(source_info, source))
    if abs(old['duration'] - new['duration']) > 100:
        raise SourceReplacementError('duration')
    if (abs((new['width'] / new['height']) / (project['width'] / project['height']) - 1) > .005
            or old['rotation'] != new['rotation'] or old['sar'] != new['sar']):
        raise SourceReplacementError('geometry')
    if old['audio'] != new['audio']:
        raise SourceReplacementError('audio')
    preview = run / media_name('preview', source_id)
    if preview.exists() or preview.is_symlink():
        raise ValueError('Replacement preview already exists')
    with failure_code('render_failed'):
        await RenderingService().capture_framing_source(str(source), str(preview))
    # Recheck immediately before committing. Failed/cancelled generation never touches the project.
    if read_json(run, 'editor-project.json')['revision'] != project['revision']:
        raise EditorError('project_changed', 'Editor project changed')
    project.pop('preview_id', None)
    project['frame_preview'] = True
    project.update(source_id=source_id, width=new['width'], height=new['height'], revision=project['revision'] + 1)
    for candidate in project['candidates']:
        candidate.pop('camera_scan', None)
        candidate.pop('dismissed_camera_markers', None)
        candidate.pop('baked_hash', None)  # Earlier bakes used the previous source.
        if candidate.get('status') == 'baked':
            candidate['status'] = 'ready'
    atomic_json(run / 'editor-project.json', project)


def signature(c):
    # Canonical comparison is parsed JSON in the UI (Python keeps .0 floats).
    return json.dumps([c['title'], c['ranges'], [[s['at_ms'], s['layout'], s['crops']] +
        ([s['transition_ms']] if s.get('transition_ms') else []) for s in c['scenes']]], separators=(',', ':'), ensure_ascii=False)


def questions(schema, judgments, threshold=None, policy=None):
    result = []
    for name, question in schema.items():
        judgment = next((j for j in judgments if j and name in j.get('questions', {})), None) or {}
        answer = judgment.get('answers', {}).get(name, {})
        probability = answer.get('noul') if question['type'] == 'noul' else answer.get('probabilities', {}).get('sufficient')
        criteria = question['criteria']
        result.append({'id': name, 'prompt': question['instructions'], 'yes': criteria.get('true', criteria.get('sufficient', '')),
            'no': criteria.get('false', criteria.get('insufficient', '')), 'probability': probability,
            'threshold': check_threshold(name, threshold if threshold is not None else (policy['threshold'] if policy else .75), policy), 'status': judgment.get('status', 'unavailable')})
    return result


async def review_candidate(c, reviewer):
    report = {'moment': {'requires_visual_context': c.get('requires_visual_context', False)}}
    accepted = await reviewer.judge(c['title'], c['ranges'], report, 'candidate')
    attempt = report['coherence']['attempts'][-1]
    cuts = []
    for (_, a), (b, _) in zip(c['ranges'], c['ranges'][1:]):
        if a == b:
            continue
        state = {'title': c['title'], 'interval': [a, b], 'removed_text': dialogue(reviewer.segments, [(a, b)]),
            'before': dialogue(reviewer.segments, [(max(0, a - 15000), a)]),
            'after': dialogue(reviewer.segments, [(b, min(reviewer.duration_ms, b + 15000))]),
            'source_context': reviewer.source_context}
        judgment = await reviewer.service.evaluate(state, CUT_QUESTIONS)
        cuts.append({'interval': [a, b], 'questions': questions(CUT_QUESTIONS, [judgment], reviewer.policy['cut_threshold'], reviewer.policy)})
    accepted = accepted and all(q['probability'] is not None and q['probability'] >= q['threshold'] for cut in cuts for q in cut['questions'])
    c['review'] = {'signature': signature(c), 'reviewed_at': datetime.now(timezone.utc).isoformat(),
        'decision': 'passes' if accepted else 'needs_attention',
        'questions': questions(CLIP_QUESTIONS, [attempt.get('judgment'), attempt.get('policy_judgment')], policy=reviewer.policy), 'cuts': cuts}


def default_crop(w, h, aspect, cx=.5):
    cw, ch = min(1, h * aspect / w), min(1, w / aspect / h)
    return [max(0, min(1 - cw, cx - cw / 2)), (1 - ch) / 2, cw, ch]


async def prepare_project(request, segments, transcript, download, renderer, reviewer, output_dir, progress):
    if not segments:
        raise NoClipCandidatesError()
    w, h = await renderer._get_video_dimensions(download.video_path)
    duration = round(download.metadata.duration_seconds * 1000)
    aspect = 9 / 16 if request.aspect_ratio == '9:16' else 16 / 9
    project = {'version': 1, 'revision': 0, 'title': utf16_prefix(download.metadata.title or '', 1024), 'width': w, 'height': h,
        'duration_ms': duration, 'aspect_ratio': request.aspect_ratio, 'candidates': [],
        'transcript': [{'start_ms': max(0, min(duration, s.start_time_ms)), 'end_ms': max(0, min(duration, s.end_time_ms)),
                        'text': utf16_prefix(s.text, 20000)} for s in transcript]}
    loop = asyncio.get_running_loop()
    from .run_diagnostics import CURRENT
    diagnostics = CURRENT.get()
    import threading
    progress_thread = threading.get_ident()
    total = min(100, len(segments))
    for i, segment in enumerate(segments[:100]):
        progress(f'Analyzing framing for candidate {i + 1} of {total}…', 100 * i / total)
        a, b = max(0, segment.start_time_ms), min(duration, segment.end_time_ms)
        if b - a < 100:
            continue
        if diagnostics:
            diagnostics.candidate(i + 1, total, b - a)
        def layout_progress(detail, percent):
            if diagnostics:
                phase = {'Sampling faces': 'sampling', 'Scanning camera changes': 'camera_scan',
                         'Refining face tracking': 'face_tracking', 'Checking shot layouts': 'vision'}.get(detail, 'sampling')
                diagnostics.phase(phase, percent)
            progress(f'Candidate {i + 1} of {total}: {detail}', 100 * i / total)
        def report_layout(detail, percent):
            if threading.get_ident() == progress_thread:
                layout_progress(detail, percent)
            else:
                loop.call_soon_threadsafe(layout_progress, detail, percent)
        plan = None
        scenes = [{'at_ms': 0, 'layout': 'fit' if request.layout_style == 'fit' else 'fill', 'crops': [default_crop(w, h, aspect)]}]
        # Suggested shot layouts stay editable; no pacing cuts or captions are baked.
        if request.aspect_ratio == '9:16' and request.layout_style != 'fit':
            try:
                plan = await renderer.layout_analyzer.analyze(download.video_path, a, b - a, w, h, request.layout_style,
                    progress=report_layout)
                scenes = []
                for j, shot in enumerate(plan.shots[:60]):
                    views = shot_views(shot, (shot.start_ms + shot.end_ms) // 2, w, h, 1080, 1920)
                    normalized = []
                    for ((x, y, cw, ch), _) in views[:2]:
                        target = aspect * len(views)
                        zoom = max(1, min(4, min(1, h * target / w) / max(.01, cw / w)))
                        base_w, base_h = min(1, h * target / w) / zoom, min(1, w / target / h) / zoom
                        normalized.append([max(0, min(1 - base_w, (x + cw / 2) / w - base_w / 2)), max(0, min(1 - base_h, (y + ch / 2) / h - base_h / 2)), base_w, base_h])
                    scenes.append({'at_ms': 0 if j == 0 else a + shot.start_ms,
                        'layout': 'split' if len(views) == 2 else 'fit' if shot.layout == LayoutType.SCREEN else 'fill',
                        'crops': normalized})
                if not scenes:
                    scenes = [{'at_ms': 0, 'layout': 'fill', 'crops': [default_crop(w, h, aspect)]}]
            except asyncio.CancelledError:
                raise
            except Exception:
                pass  # Centered framing is editable if detection isn't available.
        c = {'id': f'candidate-{i + 1}', 'title': utf16_prefix(segment.summary or f'Clip {i + 1}', 200),
            'ranges': [[a, b]], 'scenes': scenes, 'score': max(0, min(100, segment.virality_score)),
            'requires_visual_context': bool((getattr(segment, 'moment', None) or {}).get('requires_visual_context')),
            'reason': utf16_prefix(getattr(segment, 'reasoning', '') or '', 4000), 'captions': request.include_captions,
            'caption_preset': request.caption_preset, 'video_speed': request.video_speed, 'exports': [], 'review': None,
            'status': 'refining', 'caption_edits': [], 'caption_suppression_ranges': []}
        if getattr(request, 'custom_caption', None) is not None:
            from clip_engine.custom_captions import validate_custom_caption
            c['custom_caption'] = validate_custom_caption(request.custom_caption, request.caption_preset)
        if plan is not None and getattr(plan, 'camera_scan', None):
            c['camera_scan'] = plan.camera_scan
            c['dismissed_camera_markers'] = []
        if diagnostics:
            diagnostics.phase('jev')
        progress(f'Reviewing candidate {i + 1} of {total} with Jev…', 100 * i / total)
        await review_candidate(c, reviewer)
        project['candidates'].append(c)
        if diagnostics:
            diagnostics.phase(None)
    if not project['candidates']:
        raise NoClipCandidatesError()
    progress('Saving source video…', 0, 'saving')
    destination = os.path.join(output_dir, 'editor-source.mp4')
    def move_download():
        # A download in the pipeline's temporary folder is discarded after this
        # run: rename it on the same volume instead of storing a second copy.
        if getattr(download, 'source_type', 'local') == 'local':
            return False
        try:
            if os.stat(download.video_path).st_dev != os.stat(output_dir).st_dev:
                return False
            os.rename(download.video_path, destination)
        except OSError:
            return False
        return True
    # Local inputs are copied: a real copy isolates the project from later
    # changes to (or removal of) the original file.
    def copy_source():
        size, copied = os.path.getsize(download.video_path), 0
        with open(download.video_path, 'rb') as source, open(destination, 'wb') as target:
            while chunk := source.read(8 * 1024 * 1024):
                target.write(chunk)
                copied += len(chunk)
                percent = 100 * copied / max(1, size)
                loop.call_soon_threadsafe(progress, f'Saving source video: {percent:.0f}%', percent, 'saving')
    if not await asyncio.to_thread(move_download):
        await asyncio.to_thread(copy_source)
    os.chmod(destination, 0o600)
    loop = asyncio.get_running_loop()
    await renderer.capture_framing_source(destination, os.path.join(output_dir, 'editor-preview.mp4'),
        progress=lambda percent: loop.call_soon_threadsafe(progress, 'Preparing editor preview…', percent, 'preview'),
        duration_ms=duration)
    project['frame_preview'] = True
    atomic_json(Path(output_dir) / 'editor-project.json', project)
    return project


def atomic_json(path, value):
    temp = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf8', dir=path.parent, prefix='.editor-', suffix='.tmp', delete=False) as f:
            temp = f.name
            json.dump(value, f, ensure_ascii=False, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if temp and os.path.exists(temp):
            os.unlink(temp)


def local_file(run, name):
    path = run / name
    if path.is_symlink() or not path.is_file() or path.resolve().parent != run:
        raise ValueError('Editor file is unavailable')
    return path


def read_json(run, name, limit=32 * 1024 * 1024):
    path = local_file(run, name)
    with path.open('rb') as f:
        data = f.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Editor file is too large')
    return json.loads(data)


def validate_candidate(c, duration, transcript_count=100000):
    def number(n, lo, hi):
        return type(n) in (float, int) and math.isfinite(n) and lo <= n <= hi
    if not isinstance(c.get('title'), str) or not 1 <= len(c['title']) <= 200:
        raise ValueError('Invalid title')
    ranges = c['ranges']
    if not 1 <= len(ranges) <= 24:
        raise ValueError('Invalid cuts')
    previous = 0
    for a, b in ranges:
        if not number(a, previous, duration) or not number(b, a + 100, duration):
            raise ValueError('Invalid cut interval')
        previous = b
    if not 1 <= len(c['scenes']) <= 60 or c['scenes'][0]['at_ms'] != 0:
        raise ValueError('Invalid layouts')
    previous = -1
    for i, s in enumerate(c['scenes']):
        if not number(s['at_ms'], previous + .001, duration) or s['layout'] not in ('fill', 'split', 'fit'):
            raise ValueError('Invalid layout')
        previous = s['at_ms']
        transition = s.get('transition_ms', 0)
        if not number(transition, 0, 5000) or (transition and (transition < 100 or transition != int(transition)
                or i == 0 or s['layout'] == 'fit' or c['scenes'][i - 1]['layout'] != s['layout'])):
            raise ValueError('Invalid layout movement')
        if len(s['crops']) != (2 if s['layout'] == 'split' else 1):
            raise ValueError('Invalid crops')
        for x, y, w, h in s['crops']:
            if not all(number(n, 0, 1) for n in (x, y, w, h)) or min(w, h) < .01 or x + w > 1.000001 or y + h > 1.000001:
                raise ValueError('Invalid crop')
    if not number(c['video_speed'], 1, 2) or type(c['captions']) is not bool:
        raise ValueError('Invalid export settings')
    if c.get('custom_caption') is not None:
        from clip_engine.custom_captions import validate_custom_caption
        validate_custom_caption(c['custom_caption'], c['caption_preset'])
    if c.get('caption_y') is not None and not number(c['caption_y'], .1, .9):
        raise ValueError('Invalid caption position')
    if c.get('status', 'refining') not in ('refining', 'ready', 'baked', 'discarded'):
        raise ValueError('Invalid clip status')
    suppressed = c.get('caption_suppression_ranges', [])
    if not isinstance(suppressed, list) or len(suppressed) > 200:
        raise ValueError('Invalid caption suppression ranges')
    previous = 0
    for interval in suppressed:
        if not isinstance(interval, list) or len(interval) != 2:
            raise ValueError('Invalid caption suppression range')
        a, b = interval
        if not number(a, previous, duration) or not number(b, a + 100, duration):
            raise ValueError('Invalid caption suppression range')
        previous = b
    edits = c.get('caption_edits', [])
    if not isinstance(edits, list) or len(edits) > 2000:
        raise ValueError('Invalid caption edits')
    seen = set()
    for edit in edits:
        if not isinstance(edit, dict):
            raise ValueError('Invalid caption edit')
        index, text = edit.get('segment'), edit.get('text')
        if type(index) is not int or not 0 <= index < transcript_count or index in seen or not isinstance(text, str) or len(text) > 2000:
            raise ValueError('Invalid caption edit')
        if any(ord(char) < 32 and char not in '\t\n\r' for char in text):
            raise ValueError('Invalid caption text')
        seen.add(index)


def caption_transcript(transcript, edits):
    """A per-clip copy for rendering; original evidence and word timing stay intact.

    Corrections with the same word count retain the original word timestamps.
    Added/removed words are spread over the original line's spoken interval.
    """
    overrides = {edit['segment']: edit['text'] for edit in edits}
    result = []
    for index, segment in enumerate(transcript):
        if index not in overrides:
            result.append(replace(segment, words=[replace(w) for w in segment.words]))
            continue
        text = ' '.join(overrides[index].split())
        tokens = text.split()
        if not tokens:
            continue  # An empty correction hides this caption without cutting audio.
        if segment.words and len(tokens) == len(segment.words):
            words = [replace(word, word=text) for word, text in zip(segment.words, tokens)]
        else:
            start = segment.words[0].start_time_ms if segment.words else segment.start_time_ms
            end = segment.words[-1].end_time_ms if segment.words else segment.end_time_ms
            span = max(1, end - start)
            words = [TranscriptWord(word, round(start + i * span / len(tokens)), round(start + (i + 1) * span / len(tokens))) for i, word in enumerate(tokens)]
        result.append(replace(segment, text=text, words=words))
    return result


def scene_motion(c):
    """Resolve incoming crops before trimming the source window or skipping cuts."""
    previous = None
    origin = None
    for scene in c['scenes']:
        duration = scene.get('transition_ms', 0)
        if duration and previous and previous['layout'] == scene['layout'] and scene['layout'] != 'fit':
            p = min(1, (scene['at_ms'] - previous['at_ms']) / previous['transition_ms']) if previous.get('transition_ms') else 1
            ease = p * p * (3 - 2 * p)
            origin = [[a + (b - a) * ease for a, b in zip(start, end)] for start, end in zip(origin, previous['crops'])]
        else:
            origin = scene['crops']
        yield scene, origin
        previous = scene


def manual_plan(project, c):
    a, b = c['ranges'][0][0], c['ranges'][-1][1]
    shots = []
    for i, (scene, origin) in enumerate(scene_motion(c)):
        start, end = max(a, scene['at_ms']), min(b, c['scenes'][i + 1]['at_ms'] if i + 1 < len(c['scenes']) else b)
        if start >= end:
            continue
        layout = {'split': LayoutType.TWO_SHOT, 'fit': LayoutType.SCREEN, 'fill': LayoutType.TALKING_HEAD}[scene['layout']]
        crops = [] if scene['layout'] == 'fit' else scene['crops']
        duration = scene.get('transition_ms', 0)
        motion_end = min(end, scene['at_ms'] + duration)
        if duration and start < motion_end:
            shots.append(ShotLayout(start - a, motion_end - a, layout, source='manual', manual_crops=crops,
                manual_from_crops=origin, manual_transition_start_ms=scene['at_ms'] - a, manual_transition_ms=duration))
            start = motion_end
        if start < end:
            shots.append(ShotLayout(start - a, end - a, layout, source='manual', manual_crops=crops))
    return ClipLayoutPlan(shots, project['width'], project['height'])


async def run_editor(config, progress=None):
    from clip_engine.config import get_settings
    from clip_engine.services.editorial_vision import EditorialVision
    settings = get_settings()
    raw_run = Path(config['run'])
    run = raw_run.resolve(strict=True)
    if raw_run.is_symlink() or ('library' in config and run.parent != Path(config['library']).resolve(strict=True)):
        raise ValueError('Editor project is outside the library')
    project = read_json(run, 'editor-project.json')
    if project['version'] != 1 or project['revision'] != config['revision']:
        raise EditorError('project_changed', 'The editor project changed. Reopen it and retry.')
    if project.get('media_freed'):
        raise EditorError('source_missing', 'Editor media was freed')
    if config['action'] == 'replace-source':
        source_id = config['source_id']
        if not source_id or source_id == project.get('source_id'):
            raise ValueError('Invalid source generation')
        await replace_source(run, project, source_id)
        return
    c = next((c for c in project['candidates'] if c['id'] == config['candidate_id']), None)
    if c is None:
        raise EditorError('project_changed', 'Candidate is missing')
    with failure_code('invalid_edit'):
        validate_candidate(c, project['duration_ms'], len(project['transcript']))
    with failure_code('source_missing'):
        source = str(local_file(run, media_name('source', project.get('source_id'))))
    if config['action'] == 'scan-cameras':
        from clip_engine.services.camera_scan import scan_camera_changes
        def report(phase, percent):
            if progress:
                progress({'phase': phase, 'percent': percent})
        try:
            scan = await asyncio.to_thread(scan_camera_changes, source, c['ranges'][0][0], c['ranges'][-1][1],
                                           lambda percent: report('scan', percent))
        except ValueError as error:
            error.editor_code = 'scan_too_long' if 'too long' in str(error) else 'source_incompatible'
            raise
        preview = None
        try:
            # Upgrade old 30-fps proxies once. A new name avoids browser caching
            # and leaves an open preview untouched until the atomic commit.
            if not project.get('frame_preview'):
                preview_id = config.get('preview_id') or uuid4().hex
                preview = run / media_name('preview', preview_id)
                with failure_code('render_failed'):
                    await RenderingService().capture_framing_source(source, str(preview),
                        progress=lambda percent: report('preview', percent), duration_ms=project['duration_ms'])
                project.update(preview_id=preview_id, frame_preview=True)
            if read_json(run, 'editor-project.json')['revision'] != project['revision']:
                raise EditorError('project_changed', 'Editor project changed')
            c['camera_scan'] = scan
            c['dismissed_camera_markers'] = [t for t in c.get('dismissed_camera_markers', [])
                                             if any(abs(t - m['at_ms']) < .01 for m in scan['markers'])]
            project['revision'] += 1
            if len(json.dumps(project).encode('utf8')) > 32 * 1024 * 1024:
                raise ValueError('Editor project is too large')
            atomic_json(run / 'editor-project.json', project)
            preview = None
        finally:
            if preview is not None:
                preview.unlink(missing_ok=True)
        return
    with failure_code('invalid_edit'):
        rows = read_json(run, 'transcript.json')['segments']
        def timing(item):
            return {**item, 'start_time_ms': round(item['start_time_ms']), 'end_time_ms': round(item['end_time_ms'])}
        transcript = [TranscriptSegment(**{**timing(s), 'words': [TranscriptWord(**timing(w)) for w in s.get('words', [])]}) for s in rows]
    action = config['action']
    if action == 'review':
        with failure_code('review_unavailable'):
            reviewer = CoherenceReviewer(JevService.from_settings(settings, required=True), settings, transcript, project['duration_ms'])
            context = run / 'source_context.json'
            if context.exists():
                from clip_engine.services.source_context import context_for_prompt
                # Read the same bounded brief used in discovery; no new web research.
                reviewer.source_context = context_for_prompt(read_json(run, 'source_context.json'))
            with tempfile.TemporaryDirectory(prefix='.editor-review-', dir=run) as work:
                vision = EditorialVision(settings, source, work, project['duration_ms'])
                reviewer.visual_observer = vision.observe if settings.jev_visual_context else None
                await review_candidate(c, reviewer)
    elif action == 'export':
        if c.get('status', 'refining') != 'ready':
            raise EditorError('not_ready', 'Mark this clip ready before baking it')
        if any(edit['segment'] >= len(transcript) for edit in c.get('caption_edits', [])):
            raise EditorError('invalid_edit', 'Caption source changed')
        output = read_json(run, 'job_output.json')
        # job_output.json is committed before editor-project.json. If the worker
        # was killed in between, this exact edit (same revision) is already in
        # the library: finish that commit instead of rendering a duplicate.
        done = next((x for x in output['clips'] if x.get('editor_candidate') == c['id'] and x.get('editor_revision') == project['revision']
                     and x['clip_index'] not in c['exports'] and (run / f"clip_{x['clip_index']:02d}.mp4").is_file()), None)
        c['exports'].append(done['clip_index'] if done else await export_clip(run, project, c, output, source, transcript))
        c['status'] = 'baked'
        c.pop('baked_hash', None)
    else:
        raise ValueError('Unknown editor action')
    project['revision'] += 1
    atomic_json(run / 'editor-project.json', project)


async def export_clip(run, project, c, output, source, transcript):
    """Render one ready candidate and append it to the library's job output."""
    from clip_engine.custom_captions import resolve_caption_style
    render_transcript = caption_transcript(transcript, c.get('caption_edits', []))
    next_index = output.get('next_clip_index', 0)
    if type(next_index) is not int or not 0 <= next_index <= 1000:
        raise EditorError('invalid_edit', 'Invalid export sequence')
    index = max(next_index, max((x['clip_index'] for x in output['clips']), default=-1) + 1)
    while (run / f'clip_{index:02d}.mp4').exists() or (run / f'clip_{index:02d}.mp4').is_symlink():
        index += 1
    if index > 999:
        raise EditorError('invalid_edit', 'Too many exports in this project')
    with failure_code('engine_unavailable'):
        renderer = RenderingService()
    a, b = c['ranges'][0][0], c['ranges'][-1][1]
    path = run / f'clip_{index:02d}.mp4'
    if path.exists() or path.is_symlink():
        raise ValueError('Export file already exists')
    # Commit complete renders only; failed/cancelled exports do not change the library.
    with tempfile.TemporaryDirectory(prefix='.editor-export-', dir=run) as work, failure_code('render_failed'):
        result = await renderer.render_clip(RenderRequest(video_path=source, output_path=str(Path(work) / 'clip.mp4'),
            start_time_ms=a, end_time_ms=b, source_width=project['width'], source_height=project['height'],
            transcript_segments=render_transcript, include_captions=c['captions'], caption_style=resolve_caption_style(c['caption_preset'], c.get('custom_caption')),
            caption_suppression_ranges_ms=[tuple(interval) for interval in c.get('caption_suppression_ranges', [])],
            caption_y=c.get('caption_y'),
            apply_padding=False, aspect_ratio=project['aspect_ratio'], pacing='natural', video_speed=c['video_speed'],
            manual_ranges_ms=[tuple(interval) for interval in c['ranges']], manual_plan=manual_plan(project, c)))
        os.replace(result.output_path, path)
    output['clips'].append({'clip_index': index, 's3_url': str(path), 'duration_ms': result.duration_ms,
        'start_time_ms': a, 'end_time_ms': b, 'virality_score': c['score'], 'layout_type': result.layout_type,
        'summary': c['title'], 'tags': [], 'render_fallback': None,
        'editor_candidate': c['id'], 'editor_revision': project['revision']})
    output['total_clips'] = len(output['clips'])
    atomic_json(run / 'job_output.json', output)
    return index
