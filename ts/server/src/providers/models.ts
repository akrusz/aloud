/**
 * Live model lists for the web build's `/app/v1/models/:provider`.
 *
 * Mirrors the desktop fetchers (`src-tauri/src/providers.rs`): query each
 * provider's models API, filter to chat-capable text models, shape
 * `[{value, label}]`. The BYOK key arrives as `x-provider-key` and is never
 * persisted; OpenRouter is public and claude_proxy is a static alias list. Any
 * failure returns `[]`, on which the picker falls back to free-form input.
 */

export interface ModelOption {
    value: string;
    label: string;
}

const TIMEOUT_MS = 6000;

/** GET JSON with a timeout; null on any transport/non-2xx/parse error. */
async function getJson(url: string, headers: Record<string, string>): Promise<unknown | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const resp = await fetch(url, { headers, signal: ctrl.signal });
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function dataArray(body: unknown): Array<Record<string, unknown>> {
    const data = (body as { data?: unknown } | null)?.data;
    return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

/** `apiKey` is the forwarded BYOK key (may be empty). */
export async function fetchModels(provider: string, apiKey: string | null): Promise<ModelOption[]> {
    switch (provider) {
        case 'openai':
            return fetchOpenai(apiKey);
        case 'anthropic':
            return fetchAnthropic(apiKey);
        case 'claude_proxy':
            return claudeProxyModels();
        case 'openrouter':
            return fetchOpenrouter();
        case 'venice':
            return fetchVenice(apiKey);
        case 'groq':
            return fetchGroq(apiKey);
        default:
            return [];
    }
}

// ---- OpenAI ----------------------------------------------------------------

async function fetchOpenai(key: string | null): Promise<ModelOption[]> {
    if (!key) return [];
    const body = await getJson('https://api.openai.com/v1/models', {
        Authorization: `Bearer ${key}`,
    });
    if (!body) return [];
    const chatPrefixes = ['gpt-5', 'gpt-4', 'gpt-3.5', 'o1', 'o3', 'o4', 'chatgpt'];
    const exclude = [
        'realtime', 'audio', 'search', 'transcription', 'embedding', 'moderation',
        'tts', 'whisper', 'dall-e', 'instruct',
    ];
    return dataArray(body)
        .map((m) => ({ id: String(m['id'] ?? ''), created: Number(m['created'] ?? 0) }))
        .filter((m) => chatPrefixes.some((p) => m.id.startsWith(p)))
        .filter((m) => !exclude.some((t) => m.id.includes(t)))
        .sort((a, b) => b.created - a.created)
        .map((m) => ({ value: m.id, label: openaiLabel(m.id) }));
}

/** `gpt-4.1-mini` -> `GPT-4.1 Mini`, `o3-mini` -> `o3 Mini`. */
function openaiLabel(id: string): string {
    return id
        .split('-')
        .map((p) => {
            const lower = p.toLowerCase();
            if (lower === 'gpt') return 'GPT';
            if (lower === 'chatgpt') return 'ChatGPT';
            return /^[a-z]+$/i.test(p) ? p.charAt(0).toUpperCase() + p.slice(1) : p;
        })
        .join(' ')
        .replace('GPT ', 'GPT-')
        .replace('ChatGPT ', 'ChatGPT-');
}

// ---- Anthropic --------------------------------------------------------------

async function fetchAnthropic(key: string | null): Promise<ModelOption[]> {
    if (!key) return [];
    const body = await getJson('https://api.anthropic.com/v1/models', {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
    });
    if (!body) return [];
    return dataArray(body)
        .map((m) => ({
            id: String(m['id'] ?? ''),
            label: String(m['display_name'] ?? m['id'] ?? ''),
            created: String(m['created_at'] ?? ''),
        }))
        .filter((m) => m.id)
        .sort((a, b) => b.created.localeCompare(a.created))
        .map((m) => ({ value: m.id, label: m.label }));
}

// ---- Claude subscription (static aliases) ----------------------------------

function claudeProxyModels(): ModelOption[] {
    // Mirrors claude_proxy_models() in ts/src-tauri/src/providers.rs; keep in
    // sync. claude_proxy is desktop-only (web marks it unavailable), so this
    // list is parity only; the desktop Rust list is the one users hit.
    return [
        { value: 'opus', label: 'Opus (latest)' },
        { value: 'fable', label: 'Fable (latest)' },
        { value: 'sonnet', label: 'Sonnet (latest)' },
        { value: 'haiku', label: 'Haiku (latest)' },
    ];
}

// ---- OpenRouter (public) ----------------------------------------------------

async function fetchOpenrouter(): Promise<ModelOption[]> {
    const body = await getJson('https://openrouter.ai/api/v1/models', {});
    if (!body) return [];
    const keepOrgs = new Set([
        'anthropic', 'openai', 'google', 'meta-llama', 'deepseek', 'mistralai',
        'qwen', 'moonshotai',
    ]);
    return dataArray(body)
        .map((m) => ({
            id: String(m['id'] ?? ''),
            label: String(m['name'] ?? m['id'] ?? ''),
            ctx: Number(m['context_length'] ?? 0),
        }))
        .filter((m) => keepOrgs.has(m.id.split('/')[0] ?? ''))
        .filter((m) => !m.id.endsWith(':free') && !m.id.endsWith(':extended'))
        .sort((a, b) => b.ctx - a.ctx)
        .slice(0, 30)
        .map((m) => ({ value: m.id, label: m.label }));
}

// ---- Venice -----------------------------------------------------------------

async function fetchVenice(key: string | null): Promise<ModelOption[]> {
    if (!key) return [];
    const body = await getJson('https://api.venice.ai/api/v1/models', {
        Authorization: `Bearer ${key}`,
    });
    if (!body) return [];
    return dataArray(body)
        .filter((m) => {
            const t = String(m['type'] ?? '');
            return t === '' || t === 'text' || t === 'chat';
        })
        .map((m) => {
            const id = String(m['id'] ?? '');
            const name = String(m['name'] ?? '');
            return { value: id, label: name || id };
        })
        .filter((m) => m.value);
}

// ---- Groq -------------------------------------------------------------------

async function fetchGroq(key: string | null): Promise<ModelOption[]> {
    if (!key) return [];
    const body = await getJson('https://api.groq.com/openai/v1/models', {
        Authorization: `Bearer ${key}`,
    });
    if (!body) return [];
    const exclude = ['whisper', 'tts', 'guard', 'embed'];
    return dataArray(body)
        .filter((m) => m['id'] && m['active'] !== false)
        .map((m) => ({ id: String(m['id']), ctx: Number(m['context_window'] ?? 0) }))
        .filter((m) => !exclude.some((t) => m.id.toLowerCase().includes(t)))
        .sort((a, b) => b.ctx - a.ctx)
        .map((m) => ({ value: m.id, label: groqLabel(m.id) }));
}

/** `meta-llama/llama-3.1-70b` -> `Llama 3.1 70b`. */
function groqLabel(id: string): string {
    const tail = id.split('/').pop() ?? id;
    return tail
        .split('-')
        .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
        .join(' ');
}
