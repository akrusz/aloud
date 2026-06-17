/**
 * Node CLI shell — wires PromptBuilder + SessionManager + an LLM provider
 * into a text-only meditation session.
 *
 * This is an integration-test surface for the TS orchestration core, not
 * a product. Speak with the facilitator via stdin; `[HOLD]` enters local
 * silence mode (anything you type next resumes).
 *
 *   npm run cli -- --provider=ollama
 *   ANTHROPIC_API_KEY=sk-... npm run cli -- --provider=anthropic --model=claude-haiku-4-5
 *   npm run cli -- --focuses=body_sensations,emotions --qualities=compassionate --directiveness=5
 */

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, env, exit } from 'node:process';

import {
    PromptBuilder,
    SessionManager,
    parseHoldSignal,
    type Focus,
    type Quality,
    type Verbosity,
} from './facilitation/index.js';
import {
    AnthropicProvider,
    OllamaProvider,
    OpenAIProvider,
    OpenRouterProvider,
    VeniceProvider,
    GroqProvider,
    type LLMProvider,
} from './llm/index.js';
// Node-only; imported directly so the browser-targeted index barrel
// stays free of node:* specifiers.
import { ClaudeProxyProvider } from './llm/claude-proxy.js';

type ProviderName =
    | 'anthropic'
    | 'ollama'
    | 'openai'
    | 'openrouter'
    | 'venice'
    | 'groq'
    | 'claude_proxy';
const VALID_PROVIDERS: readonly ProviderName[] = [
    'anthropic',
    'ollama',
    'openai',
    'openrouter',
    'venice',
    'groq',
    'claude_proxy',
];

interface CliArgs {
    provider: ProviderName;
    model: string | undefined;
    focuses: Focus[];
    qualities: Quality[];
    directiveness: number;
    verbosity: Verbosity;
    intention: string;
    showPrompt: boolean;
}

const VALID_FOCUSES: readonly Focus[] = [
    'body_sensations',
    'emotions',
    'inner_parts',
    'open_awareness',
];
const VALID_QUALITIES: readonly Quality[] = [
    'playful',
    'compassionate',
    'loving',
    'spacious',
    'effortless',
    'feeling_good',
];

function die(msg: string): never {
    console.error(msg);
    exit(1);
}

function parseList<T extends string>(
    raw: string | undefined,
    valid: readonly T[],
    label: string
): T[] {
    if (!raw) return [];
    const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
    for (const item of items) {
        if (!valid.includes(item as T)) {
            die(`Invalid ${label}: "${item}". Valid options: ${valid.join(', ')}`);
        }
    }
    return items as T[];
}

function parseCliArgs(): CliArgs {
    const { values } = parseArgs({
        options: {
            provider: { type: 'string', default: 'ollama' },
            model: { type: 'string' },
            focuses: { type: 'string' },
            qualities: { type: 'string' },
            directiveness: { type: 'string', default: '3' },
            verbosity: { type: 'string', default: 'low' },
            intention: { type: 'string', default: '' },
            'show-prompt': { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
        },
        allowPositionals: false,
    });

    if (values.help) {
        printHelp();
        exit(0);
    }

    const provider = values.provider;
    if (!VALID_PROVIDERS.includes(provider as ProviderName)) {
        die(`Invalid provider: "${provider}". Must be one of: ${VALID_PROVIDERS.join(', ')}.`);
    }

    const verbosity = values.verbosity;
    if (verbosity !== 'low' && verbosity !== 'medium' && verbosity !== 'high') {
        die(`Invalid verbosity: "${verbosity}". Must be "low", "medium", or "high".`);
    }

    const directiveness = Number.parseInt(values.directiveness ?? '3', 10);
    if (Number.isNaN(directiveness) || directiveness < 0 || directiveness > 10) {
        die(`Invalid directiveness: "${values.directiveness}". Must be 0-10.`);
    }

    return {
        provider: provider as ProviderName,
        model: values.model,
        focuses: parseList(values.focuses, VALID_FOCUSES, 'focus'),
        qualities: parseList(values.qualities, VALID_QUALITIES, 'quality'),
        directiveness,
        verbosity,
        intention: values.intention ?? '',
        showPrompt: values['show-prompt'] ?? false,
    };
}

function printHelp(): void {
    console.log(`Usage: npm run cli -- [options]

Options:
  --provider=<name>          ${VALID_PROVIDERS.join(' | ')} (default: ollama)
  --model=<name>             override the provider's default model
  --focuses=<a,b>            ${VALID_FOCUSES.join(', ')}
  --qualities=<a,b>          ${VALID_QUALITIES.join(', ')}
  --directiveness=<0-10>     0 = pure following, 10 = strong direction (default: 3)
  --verbosity=<low|medium|high>   (default: low)
  --intention=<text>         seed the opener with a stated intention
  --show-prompt              print the assembled system prompt before starting
  --help                     this message

Env:
  ANTHROPIC_API_KEY          required when --provider=anthropic
  OPENAI_API_KEY             required when --provider=openai
  OPENROUTER_API_KEY         required when --provider=openrouter
  VENICE_API_KEY             required when --provider=venice
  GROQ_API_KEY               required when --provider=groq

Type /quit (or Ctrl+C) at any time to end the session.`);
}

function requireKey(name: string): string {
    const key = env[name];
    if (!key) die(`${name} environment variable required.`);
    return key;
}

function buildProvider(args: CliArgs): LLMProvider {
    const modelOption = args.model !== undefined ? { model: args.model } : {};
    switch (args.provider) {
        case 'anthropic':
            return new AnthropicProvider({
                apiKey: requireKey('ANTHROPIC_API_KEY'),
                ...modelOption,
            });
        case 'openai':
            return new OpenAIProvider({
                apiKey: requireKey('OPENAI_API_KEY'),
                ...modelOption,
            });
        case 'openrouter':
            return new OpenRouterProvider({
                apiKey: requireKey('OPENROUTER_API_KEY'),
                ...modelOption,
            });
        case 'venice':
            return new VeniceProvider({
                apiKey: requireKey('VENICE_API_KEY'),
                ...modelOption,
            });
        case 'groq':
            return new GroqProvider({
                apiKey: requireKey('GROQ_API_KEY'),
                ...modelOption,
            });
        case 'ollama':
            return new OllamaProvider(modelOption);
        case 'claude_proxy':
            return new ClaudeProxyProvider(modelOption);
    }
}

async function main(): Promise<void> {
    const args = parseCliArgs();

    const builder = new PromptBuilder({
        config: {
            focuses: args.focuses,
            qualities: args.qualities,
            directiveness: args.directiveness,
            verbosity: args.verbosity,
        },
    });
    const session = new SessionManager({ contextStrategy: 'full' });
    const provider = buildProvider(args);
    const systemPrompt = builder.buildSystemPrompt();

    session.startSession();

    if (args.showPrompt) {
        console.log('---- system prompt ----');
        console.log(systemPrompt);
        console.log('---- end system prompt ----\n');
    }
    console.log(`Provider: ${args.provider} (${provider.model})`);
    console.log(`Focuses: ${args.focuses.join(', ') || '(default: open_awareness)'}`);
    console.log(`Qualities: ${args.qualities.join(', ') || '(none)'}`);
    console.log(`Directiveness: ${args.directiveness}  Verbosity: ${args.verbosity}`);
    if (args.intention) console.log(`Intention: ${args.intention}`);
    console.log();

    // Generate opener (the LLM's first line, prompted by buildOpenerPrompt).
    const openerPrompt = builder.buildOpenerPrompt(args.intention);
    session.addUserMessage(openerPrompt);
    const openerResp = await provider.complete(session.getContextMessages(), {
        system: systemPrompt,
    });
    const opener = parseHoldSignal(openerResp.text);
    session.addAssistantMessage(opener.cleanText);

    console.log(`facilitator> ${opener.cleanText}\n`);
    let silenceMode = opener.signal === 'hold';
    if (silenceMode) {
        console.log('[silence mode — type anything to resume]\n');
    }

    const rl = createInterface({ input: stdin, output: stdout });

    let rlClosed = false;
    rl.on('close', () => { rlClosed = true; });

    try {
        while (!rlClosed) {
            const promptLabel = silenceMode ? '[silence] you> ' : 'you> ';
            let userInput: string;
            try {
                userInput = (await rl.question(promptLabel)).trim();
            } catch (err) {
                // Readline closes (EOF on stdin, Ctrl+D, piped input ending)
                // reject any pending question with "readline was closed".
                // Treat it as a graceful end-of-session.
                if (err instanceof Error && /readline was closed/i.test(err.message)) break;
                throw err;
            }
            if (!userInput) continue;
            if (['/quit', '/q', '/exit'].includes(userInput.toLowerCase())) break;

            if (silenceMode) silenceMode = false;

            session.addUserMessage(userInput);
            const resp = await provider.complete(session.getContextMessages(), {
                system: systemPrompt,
            });
            const { signal, cleanText } = parseHoldSignal(resp.text);
            session.addAssistantMessage(cleanText);

            console.log(`facilitator> ${cleanText}`);
            if (signal === 'hold') {
                silenceMode = true;
                console.log('[silence mode — type anything to resume]');
            }
            console.log();
        }
    } finally {
        rl.close();
        session.endSession();
        const turns = (session.state?.exchanges.length ?? 0) / 2;
        console.log(`\nSession ended. ${turns.toFixed(0)} exchanges, ${session.duration.toFixed(0)}s.`);
    }
}

main().catch((err) => {
    console.error('Error:', err instanceof Error ? err.message : err);
    exit(1);
});
