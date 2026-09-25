import asyncio
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import bridge_runner as bridge


class BridgeTests(unittest.TestCase):
    def config(self, **overrides):
        return {"contract_version": 2, "layout_vision_enabled": True, "job_id": "job-123", "video_url": "https://example.com/video", **overrides}

    def test_real_subprocess_loads_in_repo_engine(self):
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(bridge.__file__)))
        venv_python = os.path.join(repo_root, "engine", ".venv", "Scripts" if os.name == "nt" else "bin", "python.exe" if os.name == "nt" else "python")
        python = venv_python if os.path.isfile(venv_python) else sys.executable
        if python == sys.executable and any(importlib.util.find_spec(name) is None for name in ("cv2", "boto3", "pydantic_settings")):
            self.skipTest("Install the locked engine dependencies to run the real bridge subprocess test")
        with tempfile.TemporaryDirectory() as work_root:
            env = {
                **os.environ,
                "PYTHONPATH": os.path.join(repo_root, "engine"),
                "BRIDGECLIP_WORK_ROOT": work_root,
                "OPENROUTER_API_KEY": "",
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            done = subprocess.run(
                [python, os.path.abspath(bridge.__file__)],
                input=json.dumps(self.config()),
                capture_output=True,
                text=True,
                cwd=work_root,
                env=env,
                timeout=30,
            )
        self.assertEqual(done.returncode, 1, done.stderr)
        messages = [json.loads(line) for line in done.stdout.splitlines()]
        self.assertEqual(messages, [{"type": "error", "message": "Missing required API keys: OPENROUTER_API_KEY"}])

    def test_openrouter_key_alone_starts_the_pipeline(self):
        from dataclasses import make_dataclass
        Output = make_dataclass("Output", [("clips", list)])
        requests = []
        class Pipeline:
            def __init__(self, **kwargs): pass
            async def process_video(self, request):
                requests.append(request)
                return types.SimpleNamespace(status="completed", output=Output([]), job_id="job-123")
        modules = {
            "clip_engine.config": types.SimpleNamespace(
                get_settings=lambda: types.SimpleNamespace(openrouter_api_key="test-openrouter"),
                get_caption_preset=lambda name: None),
            "clip_engine.bridge_contract": types.SimpleNamespace(BRIDGE_CONTRACT_VERSION=2),
            "clip_engine.logging_safety": types.SimpleNamespace(install_safe_logging=lambda: None),
            "clip_engine.services.ai_clipping_pipeline": types.SimpleNamespace(
                AIClippingPipeline=Pipeline, ClippingJobRequest=lambda **kwargs: kwargs,
                JobStatus=types.SimpleNamespace(COMPLETED="completed")),
        }
        with patch.dict(sys.modules, modules), redirect_stdout(io.StringIO()) as output:
            self.assertTrue(asyncio.run(bridge.run(self.config())))
        self.assertIn('"type": "result"', output.getvalue())
        self.assertEqual(requests[-1]["video_speed"], 1)
        with patch.dict(sys.modules, modules), redirect_stdout(io.StringIO()):
            self.assertTrue(asyncio.run(bridge.run(self.config(video_speed=1.5))))
        self.assertEqual(requests[-1]["video_speed"], 1.5)

    def test_video_speed_validation(self):
        for speed in (1, 1.1, 1.25, 1.5, 1.75, 2):
            self.assertEqual(bridge.validate_config(self.config(video_speed=speed))["video_speed"], speed)
        for speed in (None, True, "1.5", 0, 0.5, 2.01, float("nan"), float("inf")):
            with self.subTest(speed=speed), self.assertRaises(ValueError):
                bridge.validate_config(self.config(video_speed=speed))

    def test_rejects_invalid_config_without_importing_bridgeclip(self):
        for value in ([], None, "config", self.config(contract_version=None), self.config(contract_version=1), self.config(layout_vision_enabled=None), self.config(job_id="../escape"), self.config(video_url="file:///etc/passwd"), self.config(max_clips=True), self.config(aspect_ratio="1:1"), self.config(layout_style="unknown"), self.config(pacing="unknown"), self.config(clipping_mode="unknown"), self.config(duration_ranges=["unknown"])):
            with self.subTest(value=value), self.assertRaises(ValueError):
                bridge.validate_config(value)

    def test_output_and_local_mode_are_set_before_settings_load(self):
        observed = []
        def get_settings():
            observed.append((os.environ["LOCAL_MODE"], os.environ["LOCAL_OUTPUT_DIR"], os.environ["LAYOUT_VISION_ENABLED"]))
            return types.SimpleNamespace(openrouter_api_key=None)
        config_module = types.SimpleNamespace(get_settings=get_settings, get_caption_preset=lambda name: None)
        pipeline_module = types.SimpleNamespace(AIClippingPipeline=None, ClippingJobRequest=None, JobStatus=None)
        with patch.dict(sys.modules, {"clip_engine.config": config_module, "clip_engine.bridge_contract": types.SimpleNamespace(BRIDGE_CONTRACT_VERSION=2), "clip_engine.logging_safety": types.SimpleNamespace(install_safe_logging=lambda: None), "clip_engine.services.ai_clipping_pipeline": pipeline_module}), patch.dict(os.environ, {"LOCAL_MODE": "false"}), redirect_stdout(io.StringIO()):
            self.assertFalse(asyncio.run(bridge.run(self.config(output_dir=os.path.abspath("output")))))
        self.assertEqual(observed, [("true", os.path.abspath("output"), "true")])

    def test_disabling_vision_is_applied_before_engine_settings_load(self):
        observed = []
        def get_settings():
            observed.append(os.environ["LAYOUT_VISION_ENABLED"])
            return types.SimpleNamespace(openrouter_api_key=None)
        config_module = types.SimpleNamespace(get_settings=get_settings, get_caption_preset=lambda name: None)
        pipeline_module = types.SimpleNamespace(AIClippingPipeline=None, ClippingJobRequest=None, JobStatus=None)
        modules = {"clip_engine.config": config_module, "clip_engine.bridge_contract": types.SimpleNamespace(BRIDGE_CONTRACT_VERSION=2), "clip_engine.logging_safety": types.SimpleNamespace(install_safe_logging=lambda: None), "clip_engine.services.ai_clipping_pipeline": pipeline_module}
        with patch.dict(sys.modules, modules), redirect_stdout(io.StringIO()):
            self.assertFalse(asyncio.run(bridge.run(self.config(layout_vision_enabled=False))))
        self.assertEqual(observed, ["false"])

    def test_economy_models_are_selected_before_engine_settings_load(self):
        observed = []
        def get_settings():
            observed.append({key: os.environ.get(key) for key in (
                "CLIPPING_MODE", "PLANNER_MODEL", "PLANNER_FALLBACK_MODELS", "LAYOUT_VISION_ENABLED"
            )})
            return types.SimpleNamespace(openrouter_api_key=None)
        modules = {
            "clip_engine.config": types.SimpleNamespace(get_settings=get_settings, get_caption_preset=lambda name: None),
            "clip_engine.bridge_contract": types.SimpleNamespace(BRIDGE_CONTRACT_VERSION=2),
            "clip_engine.logging_safety": types.SimpleNamespace(install_safe_logging=lambda: None),
            "clip_engine.services.ai_clipping_pipeline": types.SimpleNamespace(AIClippingPipeline=None, ClippingJobRequest=None, JobStatus=None),
        }
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {}, clear=True), redirect_stdout(io.StringIO()):
            self.assertFalse(asyncio.run(bridge.run(self.config(clipping_mode="economy"))))
        self.assertEqual(observed, [{
            "CLIPPING_MODE": "economy", "PLANNER_MODEL": "z-ai/glm-5.3-flash",
            "PLANNER_FALLBACK_MODELS": "", "LAYOUT_VISION_ENABLED": "false",
        }])

    def test_malformed_json_has_structured_error_and_failure_exit(self):
        output = io.StringIO()
        with patch.object(sys, "argv", ["bridge_runner.py", "[]"]), redirect_stdout(output):
            self.assertEqual(bridge.main(), 1)
        self.assertEqual(json.loads(output.getvalue())["type"], "error")

    def test_advanced_models_are_applied_before_cached_settings_load(self):
        observed = []
        keys = ("CLIPPING_MODE", "PLANNER_MODEL", "ADVANCED_TRANSCRIPTION_MODEL", "PLANNER_FALLBACK_MODELS", "PLANNER_MAX_OUTPUT_TOKENS", "PLANNER_SUPPORTS_IMAGES")
        def get_settings():
            observed.append({key: os.environ.get(key) for key in keys})
            return types.SimpleNamespace(openrouter_api_key=None)
        modules = {
            "clip_engine.config": types.SimpleNamespace(get_settings=get_settings, get_caption_preset=lambda name: None),
            "clip_engine.bridge_contract": types.SimpleNamespace(BRIDGE_CONTRACT_VERSION=2),
            "clip_engine.logging_safety": types.SimpleNamespace(install_safe_logging=lambda: None),
            "clip_engine.services.ai_clipping_pipeline": types.SimpleNamespace(AIClippingPipeline=None, ClippingJobRequest=None, JobStatus=None),
        }
        config = self.config(clipping_mode="advanced", planner_model="vendor/planner", transcription_model="vendor/speech",
                             planner_max_output_tokens=8192, planner_supports_images=False)
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {}, clear=True), redirect_stdout(io.StringIO()):
            self.assertFalse(asyncio.run(bridge.run(config)))
        self.assertEqual(observed, [dict(zip(keys, ["advanced", "vendor/planner", "vendor/speech", "", "8192", "false"]))])

    def test_advanced_model_ids_and_capabilities_are_validated(self):
        config = self.config(clipping_mode="advanced", planner_model="vendor/planner", transcription_model="vendor/speech")
        self.assertEqual(bridge.validate_config(config), config)
        for patch_values in [{"planner_model": ""}, {"transcription_model": None}, {"planner_model": "a/b,c/d"},
                             {"planner_model": "vendor/model\n"}, {"planner_model": "https://example.com/model"},
                             {"planner_max_output_tokens": 32001}, {"planner_supports_images": "true"},
                             {"planner_input_price": float("nan")}, {"clipping_mode": "quality"}]:
            with self.subTest(patch=patch_values), self.assertRaises(ValueError):
                bridge.validate_config({**config, **patch_values})

    def test_stdin_transport_and_size_limit(self):
        async def success(config):
            return True
        with patch.object(sys, "argv", ["bridge_runner.py"]), patch.object(sys, "stdin", io.StringIO(json.dumps(self.config()))), patch.object(bridge, "run", success):
            self.assertEqual(bridge.main(), 0)
        with patch.object(sys, "argv", ["bridge_runner.py"]), patch.object(sys, "stdin", io.StringIO(" " * 65537)), redirect_stdout(io.StringIO()):
            self.assertEqual(bridge.main(), 1)

    def test_provider_errors_do_not_disclose_exception_text(self):
        output = io.StringIO()
        async def fail(config):
            raise RuntimeError("private-provider-token")
        with patch.object(sys, "argv", ["bridge_runner.py", json.dumps(self.config())]), patch.object(bridge, "run", fail), redirect_stdout(output), self.assertLogs(bridge.logger) as logs:
            self.assertEqual(bridge.main(), 1)
        self.assertNotIn("private-provider-token", output.getvalue() + str(logs.output))

    def test_server_proxies_are_cleared_before_settings_load(self):
        observed = []
        def get_settings():
            observed.append((os.environ["YTDLP_PROXIES"], os.environ["YTDLP_PROXY"]))
            return types.SimpleNamespace(openrouter_api_key=None)
        config_module = types.SimpleNamespace(get_settings=get_settings, get_caption_preset=lambda name: None)
        pipeline_module = types.SimpleNamespace(AIClippingPipeline=None, ClippingJobRequest=None, JobStatus=None)
        with patch.dict(sys.modules, {"clip_engine.config": config_module, "clip_engine.bridge_contract": types.SimpleNamespace(BRIDGE_CONTRACT_VERSION=2), "clip_engine.logging_safety": types.SimpleNamespace(install_safe_logging=lambda: None), "clip_engine.services.ai_clipping_pipeline": pipeline_module}), patch.dict(os.environ, {"YTDLP_PROXIES": "socks5h://user:pass@proxy:1"}), redirect_stdout(io.StringIO()):
            asyncio.run(bridge.run(self.config()))
        self.assertEqual(observed, [("", "")])

    def test_failures_map_to_fixed_messages(self):
        blocked = bridge.describe_failure("YouTube download failed after trying all 5 proxies. Last error: ERROR: unable to download video data: HTTP Error 403: Forbidden")
        self.assertEqual(blocked["message"], "The video service refused the download.")
        secret = "socks5h://user:secret-pass@10.0.0.1:1 /Users/someone/private.mp4"
        fallback = bridge.describe_failure(RuntimeError(secret))
        self.assertEqual(fallback["message"], "The clipping pipeline failed.")
        self.assertNotIn("secret-pass", json.dumps(fallback))
        self.assertEqual(bridge.describe_failure(None)["message"], "The clipping pipeline failed.")
        empty = bridge.describe_failure("No clip-worthy moments found (the video may have no speech, or the selected time range is too short for the chosen clip length)")
        self.assertEqual(empty["message"], "BridgeClip couldn't find any clips in this video.")
        self.assertEqual(bridge.describe_failure("Transcription authentication failed")["message"], "OpenRouter rejected the transcription request.")
        self.assertEqual(bridge.describe_failure("Transcription account credit limit reached")["message"], "OpenRouter could not transcribe the video because the account has insufficient credit or a spending limit.")
        self.assertEqual(bridge.describe_failure("Transcription providers are temporarily rate limited")["message"], "Transcription providers are busy after automatic recovery attempts.")
        self.assertEqual(bridge.describe_failure("Transcription service unavailable")["message"], "OpenRouter could not be reached for transcription.")
        self.assertEqual(bridge.describe_failure("Transcription request rejected by provider")["message"], "OpenRouter rejected the transcription audio request.")
        self.assertEqual(bridge.describe_failure("Transcription response lacked word timestamps")["message"], "OpenRouter returned a transcript without word timestamps.")
        self.assertEqual(bridge.describe_failure("Video render failed")["message"], "Clip rendering failed.")
        self.assertEqual(bridge.describe_failure("Not enough disk space to save clips")["message"],
                         "There is not enough free disk space to finish this video.")
        self.assertEqual(bridge.describe_failure("Video download failed")["message"], "The video could not be downloaded.")

    def test_twitch_failures_are_actionable_and_safe_for_the_desktop(self):
        cases = {
            "Unsupported Twitch source": "Choose a public, completed Twitch VOD.",
            "Twitch VOD is not completed": "This Twitch video is still live or processing.",
            "Twitch VOD duration is invalid or too long": "This Twitch video has no usable duration or exceeds the six hour limit.",
            "Twitch VOD unavailable": "The Twitch VOD could not be downloaded.",
        }
        for error, message in cases.items():
            with self.subTest(error=error):
                result = bridge.describe_failure(error)
                self.assertEqual(result["message"], message)
                self.assertTrue(result["hint"])
                for value in result.values():
                    self.assertNotIn("/", value)
                    self.assertNotIn("https:", value)
        self.assertIn("signed out", bridge.describe_failure("Twitch VOD unavailable")["hint"])

    def test_engine_stdout_cannot_corrupt_protocol(self):
        script = (
            "import os, subprocess, sys; import bridge_runner as b\n"
            "b.reserve_stdout_for_protocol()\n"
            "sys.stdout.write('[download]   6.0% of 166MiB\\r'); sys.stdout.flush()\n"
            "subprocess.run([sys.executable, '-c', 'print(\"child noise\")'])\n"
            "b.emit({'type': 'error', 'message': 'x'})\n"
        )
        done = subprocess.run([sys.executable, "-c", script], cwd=os.path.dirname(os.path.abspath(bridge.__file__)), capture_output=True, text=True, timeout=30)
        self.assertEqual(done.stdout, json.dumps({"type": "error", "message": "x"}) + "\n")
        self.assertIn("child noise", done.stderr)


if __name__ == '__main__':
    unittest.main()
