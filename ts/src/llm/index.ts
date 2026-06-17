export type {
    CompletionOptions,
    CompletionResult,
    LLMProvider,
    Message,
    Role,
    StreamChunk,
} from './base.js';

export { AnthropicProvider, type AnthropicProviderOptions } from './anthropic.js';
export { OllamaProvider, type OllamaProviderOptions } from './ollama.js';
export {
    OpenAIProvider,
    OpenRouterProvider,
    VeniceProvider,
    GroqProvider,
    GoogleProvider,
    type OpenAIProviderOptions,
} from './openai.js';
// ClaudeProxyProvider is Node-only (uses node:child_process). Import
// directly from './claude-proxy.js' from Node entrypoints — keeping it
// off this barrel avoids dragging node:* into browser bundles.
