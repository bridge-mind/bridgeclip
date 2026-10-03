// The BridgeClip assistant runs on the user's own AI account. Either BridgeClip
// starts their Claude Code or Codex CLI, signed in with their Claude or ChatGPT
// subscription, headless for each turn and gives it BridgeClip's tools through
// a loopback MCP server (BridgeClip never sees those credentials), or it calls
// a model on OpenRouter with the user's OpenRouter key and runs the tools itself.

import { isModelId } from './openrouter-models'

/** Providers reached by running the user's own CLI. */
export const ASSISTANT_CLI_PROVIDERS = ['claude', 'codex'] as const
export type AssistantCliProviderId = (typeof ASSISTANT_CLI_PROVIDERS)[number]
export const ASSISTANT_PROVIDERS = [...ASSISTANT_CLI_PROVIDERS, 'openrouter'] as const
export type AssistantProviderId = (typeof ASSISTANT_PROVIDERS)[number]

export function isAssistantProvider(value: unknown): value is AssistantProviderId {
  return typeof value === 'string' && (ASSISTANT_PROVIDERS as readonly string[]).includes(value)
}

export function isAssistantCliProvider(value: unknown): value is AssistantCliProviderId {
  return typeof value === 'string' && (ASSISTANT_CLI_PROVIDERS as readonly string[]).includes(value)
}

export interface AssistantProviderInfo {
  id: AssistantProviderId
  /** What BridgeClip runs or calls. */
  name: string
  /** Whose models it runs; shown beside the provider's logo. */
  brand: string
  /** What pays for the chat. */
  subscription: string
  /** Installer the provider documents; shown for copying, never run by BridgeClip. Null without a CLI. */
  installCommand: string | null
  /** What to run in a terminal to sign in. Null without a CLI. */
  signInCommand: string | null
  docsUrl: string
}

export const ASSISTANT_PROVIDER_INFO: Record<AssistantProviderId, AssistantProviderInfo> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    brand: 'Claude',
    subscription: 'Claude Pro or Max',
    installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
    signInCommand: 'claude',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup'
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    brand: 'OpenAI',
    subscription: 'ChatGPT Plus, Pro or Business',
    installCommand: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    signInCommand: 'codex login',
    docsUrl: 'https://developers.openai.com/codex/cli'
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    brand: 'OpenRouter',
    subscription: 'OpenRouter API key',
    installCommand: null,
    signInCommand: null,
    docsUrl: 'https://openrouter.ai/models'
  }
}

export type AssistantConnectionState = 'not-installed' | 'signed-out' | 'connected' | 'unknown'

export interface AssistantProviderStatus {
  id: AssistantProviderId
  state: AssistantConnectionState
  version: string | null
  /** Account email when the CLI reports one. */
  account: string | null
  /** Subscription plan when the CLI reports one, e.g. "max" or "pro". */
  plan: string | null
  /** Why the state is unknown, or a hint for the user. */
  detail: string | null
  checkedAt: string
}

export interface AssistantModelOption {
  /** Passed to the CLI; '' leaves the CLI's own default. */
  id: string
  label: string
}

export const ASSISTANT_MODELS: Record<AssistantProviderId, readonly AssistantModelOption[]> = {
  claude: [
    { id: '', label: 'Default' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'opus', label: 'Opus' },
    { id: 'fable', label: 'Fable' },
    { id: 'haiku', label: 'Haiku' }
  ],
  codex: [
    { id: '', label: 'Default' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna' }
  ],
  // Any tool-calling model in OpenRouter's live catalog; see OPENROUTER_ASSISTANT_SUGGESTIONS.
  openrouter: []
}

/** Shown first in the OpenRouter list when the catalog has them: the models BridgeClip's clipping presets use. */
export const OPENROUTER_ASSISTANT_SUGGESTIONS = ['anthropic/claude-opus-5.5', 'openai/gpt-6-sol', 'google/gemini-3.8-flash'] as const

/** '' is the CLI's default, or for OpenRouter "not chosen yet". */
export function isAssistantModel(provider: AssistantProviderId, value: unknown): value is string {
  if (provider === 'openrouter') return value === '' || isModelId(value)
  return typeof value === 'string' && ASSISTANT_MODELS[provider].some((model) => model.id === value)
}

/** The model's short name: "Opus", "GPT-5.6 Sol", or an OpenRouter catalog name ("Anthropic: Claude Opus 5.5"). */
export function assistantModelLabel(provider: AssistantProviderId, model: string, catalogName?: string | null): string | null {
  if (!model) return null
  if (provider === 'openrouter') return catalogName || model
  return ASSISTANT_MODELS[provider].find((option) => option.id === model)?.label ?? null
}

/** "Claude Opus", "GPT-5.6 Sol", "Anthropic: Claude Opus 5.5"; the provider's brand alone for the CLI's default. */
export function assistantModelName(provider: AssistantProviderId, model: string, catalogName?: string | null): string {
  const brand = ASSISTANT_PROVIDER_INFO[provider].brand
  const label = assistantModelLabel(provider, model, catalogName)
  if (!label) return brand
  // Claude's aliases are bare family names ("Opus"); the other labels already name the model.
  return provider === 'claude' ? `${brand} ${label}` : label
}

export interface AssistantPreferences {
  provider: AssistantProviderId | null
  models: Record<AssistantProviderId, string>
}

export const DEFAULT_ASSISTANT_PREFERENCES: AssistantPreferences = {
  provider: null,
  models: { claude: '', codex: '', openrouter: '' }
}

export type AssistantToolStatus = 'running' | 'awaiting-approval' | 'done' | 'error' | 'denied'

export interface AssistantToolCall {
  id: string
  /** BridgeClip tool name without the MCP prefix. */
  name: string
  title: string
  input: unknown
  status: AssistantToolStatus
  /** Short result or error text for display. */
  summary: string | null
}

export interface AssistantMessagePart {
  kind: 'text' | 'tool'
  text?: string
  tool?: AssistantToolCall
}

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  createdAt: string
  parts: AssistantMessagePart[]
  /** Set when the turn ended with an error. */
  error?: string | null
  /** Who wrote an assistant reply. A chat can switch models between turns; older replies fall back to the chat's. */
  provider?: AssistantProviderId
  model?: string
}

export interface AssistantConversation {
  id: string
  title: string
  provider: AssistantProviderId
  model: string
  /** Claude session id or Codex thread id used to resume the conversation. */
  resumeId: string | null
  createdAt: string
  updatedAt: string
  messages: AssistantMessage[]
}

export interface AssistantConversationSummary {
  id: string
  title: string
  provider: AssistantProviderId
  updatedAt: string
}

export interface AssistantApprovalRequest {
  id: string
  conversationId: string
  toolCallId: string
  tool: string
  title: string
  /** Plain-language description of exactly what will happen. */
  details: string[]
}

export type AssistantEvent =
  | { type: 'turn-start'; conversationId: string; messageId: string }
  | { type: 'text-delta'; conversationId: string; messageId: string; text: string }
  | { type: 'tool'; conversationId: string; messageId: string; tool: AssistantToolCall }
  | { type: 'approval'; conversationId: string; request: AssistantApprovalRequest }
  | { type: 'approval-resolved'; conversationId: string; requestId: string }
  | { type: 'turn-end'; conversationId: string; messageId: string; error: string | null }
  | { type: 'conversation'; conversation: AssistantConversationSummary }

export const ASSISTANT_PROMPT_MAX_CHARS = 20000

/** A sign-in BridgeClip started with the provider's own CLI (`claude auth login`, `codex login`). */
export interface AssistantSignInState {
  provider: AssistantCliProviderId
  status: 'idle' | 'waiting' | 'succeeded' | 'failed'
  /** The provider's sign-in page, when the CLI printed one. */
  url: string | null
  /** Claude can ask for a code shown in the browser after sign-in. */
  acceptsCode: boolean
  message: string | null
}

/** Pages the assistant can show; mirrors the renderer's sidebar pages. */
export type AssistantNavigationPage = 'clip' | 'library' | 'jobs' | 'captions' | 'accounts' | 'posts' | 'automations' | 'settings'
export type AppDataScope = 'library' | 'automations' | 'posts' | 'settings' | 'accounts'
