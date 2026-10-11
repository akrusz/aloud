/**
 * Provider specs for the soak CLI: "anthropic", "anthropic:claude-haiku-5-5",
 * "ollama:qwen3", "openrouter:deepseek/deepseek-v3.2". Same provider set as
 * src/cli.ts, keys from the environment (loadServerEnv runs first).
 *
 * "anthropic" is the developer's own Claude subscription unless asked
 * otherwise: see scriptClaude.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

export type ClaudeVia = 'subscription' | 'api';

/** `ALOUD_CLAUDE_VIA=api` puts the dev scripts on the API key; anything else,
 *  or nothing, is the subscription. */
export function claudeVia(): ClaudeVia {
    return (process.env['ALOUD_CLAUDE_VIA'] ?? '').toLowerCase() === 'api' ? 'api' : 'subscription';
}

/** The API provider's own default, so "anthropic" names the same model either way. */
const DEFAULT_CLAUDE = 'claude-sonnet-5-5';

/**
 * Claude for the dev scripts (soak, evals, A/Bs, one-off probes): the
 * developer's subscription through the `claude` CLI, so a few hundred calls
 * cost quota rather than API credit. `ALOUD_CLAUDE_VIA=api` asks for the key.
 *
 * It is the desktop app's "Anthropic Subscription" path, not aloud cloud's
 * request: the conversation goes in as one prompt, the CLI adds a line of
 * identity and an environment block (~570 tokens), and its startup is in every
 * latency. Same model, close but not the same behaviour: on the check-in
 * probe (2026-10-11, five transcripts, two asks each) it gave the API's
 * verdict in 9 cells of 10 and the opposite one in the tenth. Good for
 * exploring; confirm on the key anything that will decide a prompt change, and
 * use the key when the request itself is what is being measured (latency,
 * caching, a model about to ship).
 *
 * Three things the CLI would otherwise inherit from a script:
 * - ANTHROPIC_API_KEY, which loadServerEnv has just put in the environment.
 *   With it set the CLI bills the key, silently.
 * - The repo as working directory: it reads CLAUDE.md from there and every
 *   parent, and the facilitator would get this project's agent instructions.
 * - The CLAUDE_CODE* variables of an agent session running the script.
 */
export function scriptClaude(model: string = DEFAULT_CLAUDE): LLMProvider {
    if (claudeVia() === 'api') return new AnthropicProvider({ apiKey: requireKey('anthropic'), model });
    return subscriptionClaude(model);
}

function subscriptionClaude(model: string): LLMProvider {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
        if (/^(ANTHROPIC_|CLAUDE_CODE|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(name)) delete env[name];
    }
    const cwd = join(homedir(), '.cache', 'aloud', 'claude-cli');
    mkdirSync(cwd, { recursive: true });
    return new ClaudeProxyProvider({
        model,
        env,
        cwd,
        // The API path pins these models to low and switches thinking off on
        // the rest, which the CLI has no flag for; low is as near as it gets.
        effort: 'low',
    });
}

export function buildProviderFromSpec(spec: string): LLMProvider {
    const sep = spec.indexOf(':');
    const name = sep === -1 ? spec : spec.slice(0, sep);
    const model = sep === -1 ? undefined : spec.slice(sep + 1);
    const modelOption = model !== undefined && model !== '' ? { model } : {};
    switch (name) {
        case 'anthropic':
            return scriptClaude(model || undefined);
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
            return subscriptionClaude(model || 'sonnet');
        case 'anthropic_api':
            return new AnthropicProvider({ apiKey: requireKey('anthropic'), ...modelOption });
        default:
            throw new Error(
                `Unknown provider "${name}". Use one of: anthropic, anthropic_api, openai, openrouter, venice, groq, ollama, claude_proxy (optionally ":model").`
            );
    }
}
