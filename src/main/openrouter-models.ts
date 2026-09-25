import { isModelId, type ModelTask, type OpenRouterCatalog, type OpenRouterModel } from '../shared/openrouter-models'
import { readResponseText } from './http-response'

const CACHE_MS = 10 * 60 * 1000
let cached: OpenRouterCatalog | null = null
let pending: Promise<OpenRouterCatalog> | null = null

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function number(value: unknown, positive = false): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && (positive ? n > 0 : n >= 0) ? n : null
}

export function parseModelCatalog(value: unknown, task: ModelTask): OpenRouterModel[] {
  const data = record(value).data
  if (!Array.isArray(data) || data.length > 10000) throw new Error('OpenRouter returned an invalid model catalog.')
  const models = new Map<string, OpenRouterModel>()
  for (const entry of data) {
    const raw = record(entry)
    const architecture = record(raw.architecture)
    const inputs = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : []
    const outputs = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : []
    if (!isModelId(raw.id) || !inputs.includes(task === 'planning' ? 'text' : 'audio') ||
        !outputs.includes(task === 'planning' ? 'text' : 'transcription')) continue
    const parameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : []
    let unavailableReason: string | null = null
    if (task === 'planning' && !parameters.includes('structured_outputs')) {
      unavailableReason = 'Does not advertise the structured output required for clip planning.'
    }
    if (task === 'transcription' && ['openai/gpt-4o-transcribe', 'microsoft/mai-transcribe-1.5'].includes(raw.id)) {
      unavailableReason = 'Does not support the timestamped transcripts required for clipping.'
    }
    const pricing = record(raw.pricing)
    models.set(raw.id, {
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name.slice(0, 160).split('').filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('') : raw.id,
      contextLength: number(raw.context_length, true),
      maxOutputTokens: number(record(raw.top_provider).max_completion_tokens, true),
      supportsImages: inputs.includes('image'),
      // Transcription catalog prices have provider-dependent units. Don't label them as token prices.
      inputPrice: task === 'planning' ? number(pricing.prompt) : null,
      outputPrice: task === 'planning' ? number(pricing.completion) : null,
      unavailableReason
    })
  }
  if (!models.size) throw new Error('OpenRouter returned an empty model catalog. Try refreshing.')
  return [...models.values()].sort((a, b) => Number(Boolean(a.unavailableReason)) - Number(Boolean(b.unavailableReason)) || a.name.localeCompare(b.name))
}

async function fetchModels(task: ModelTask): Promise<OpenRouterModel[]> {
  try {
    // This is a public, read-only catalog. No API key or user-provided URL leaves the main process.
    const response = await fetch(`https://openrouter.ai/api/v1/models?output_modalities=${task === 'planning' ? 'text' : 'transcription'}`, {
      redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' }
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('Model catalog unavailable')
    }
    return parseModelCatalog(JSON.parse(await readResponseText(response, 8 * 1024 * 1024)), task)
  } catch {
    throw new Error('Could not load OpenRouter models. Check your connection and refresh the model list.')
  }
}

export async function getModelCatalog(refresh: unknown = false): Promise<OpenRouterCatalog> {
  if (typeof refresh !== 'boolean') throw new Error('Invalid model refresh option')
  if (pending) return pending
  if (!refresh && cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_MS) return cached
  pending = Promise.all([fetchModels('planning'), fetchModels('transcription')]).then(([planning, transcription]) => {
    cached = { planning, transcription, fetchedAt: new Date().toISOString() }
    return cached
  })
  try { return await pending } finally { pending = null }
}

export async function resolveAdvancedModels(plannerId: string, transcriptionId: string): Promise<OpenRouterModel> {
  const catalog = await getModelCatalog()
  for (const [task, id] of [['planning', plannerId], ['transcription', transcriptionId]] as const) {
    const model = catalog[task].find((item) => item.id === id)
    if (!model) throw new Error(`The selected ${task} model is no longer listed. Refresh the models in Advanced mode.`)
    if (model.unavailableReason) throw new Error(model.unavailableReason)
  }
  return catalog.planning.find((item) => item.id === plannerId)!
}
