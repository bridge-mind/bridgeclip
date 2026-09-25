export type ModelTask = 'planning' | 'transcription'

export interface OpenRouterModel {
  id: string
  name: string
  contextLength: number | null
  maxOutputTokens: number | null
  supportsImages: boolean
  inputPrice: number | null
  outputPrice: number | null
  unavailableReason: string | null
}

export interface OpenRouterCatalog {
  planning: OpenRouterModel[]
  transcription: OpenRouterModel[]
  fetchedAt: string
}

export function isModelId(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length <= 120 && /^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(value)
}

export function searchModels(models: OpenRouterModel[], query: string): OpenRouterModel[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return models.filter((model) => terms.every((term) => `${model.name} ${model.id}`.toLowerCase().includes(term)))
}
