/** Keep in sync with engine/config.py and bridge_runner.py; covered by model contract tests. */
export const CLIPPING_MODELS = {
  quality: { planner: 'anthropic/claude-opus-5.5', plannerName: 'Claude Opus 5.5', transcription: 'microsoft/mai-transcribe-2', transcriptionName: 'MAI Transcribe 2', fallbacks: 'Gemini 3.8 Flash → GPT-6 Sol' },
  economy: { planner: 'z-ai/glm-5.3-flash', plannerName: 'GLM 5.3 Flash', transcription: 'openai/whisper-large-v3-turbo', transcriptionName: 'Whisper Turbo', fallbacks: '' }
} as const
