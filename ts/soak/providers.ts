/**
 * Provider specs for the soak CLI: "anthropic", "anthropic:claude-haiku-4-5",
 * "ollama:qwen3", "openrouter:deepseek/deepseek-v3.2". Same provider set as
 * src/cli.ts, keys from the environment (loadServerEnv runs first).
 */

import {
    AnthropicProvider,
    GroqProvider,
    OllamaProvider,
    OpenAIProvider,
    OpenRouterProvider,
    VeniceProvider,
    type LLMProvider,
} from '../src/llm/index.js';
// Node-only, off the browser barrel (as in src/cli.ts).
import { ClaudeProxyProvider } from '../src/llm/claude-proxy.js';

const KEY_VARS: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    venice: 'VENICE_API_KEY',
    groq: 'GROQ_API_KEY',
};

function requireKey(provider: string): string {
    const name = KEY_VARS[provider] as string;
    const key = process.env[name];
    if (!key) {
        throw new Error(`${name} is required for provider "${provider}" (set it or fill ts/server/.env)`);
    }
    return key;
}

export function buildProviderFromSpec(spec: string): LLMProvider {
    const sep = spec.indexOf(':');
    const name = sep === -1 ? spec : spec.slice(0, sep);
    const model = sep === -1 ? undefined : spec.slice(sep + 1);
    const modelOption = model !== undefined && model !== '' ? { model } : {};
    switch (name) {
        case 'anthropic':
            return new AnthropicProvider({ apiKey: requireKey(name), ...modelOption });
        case 'openai':
            return new OpenAIProvider({ apiKey: requireKey(name), ...modelOption });
        case 'openrouter':
            return new OpenRouterProvider({ apiKey: requireKey(name), ...modelOption });
        case 'venice':
            return new VeniceProvider({ apiKey: requireKey(name), ...modelOption });
        case 'groq':
            return new GroqProvider({ apiKey: requireKey(name), ...modelOption });
        case 'ollama':
            return new OllamaProvider(modelOption);
        case 'claude_proxy':
            return new ClaudeProxyProvider(modelOption);
        default:
            throw new Error(
                `Unknown provider "${name}". Use one of: anthropic, openai, openrouter, venice, groq, ollama, claude_proxy (optionally ":model").`
            );
    }
}
