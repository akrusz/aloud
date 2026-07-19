/**
 * Direct probes to the local Ollama daemon via the `/ollama` dev proxy (Vite
 * rewrites it to http://localhost:11434), the same path capabilities.ts uses.
 *
 * The app backend normally aggregates Ollama state at `/app/v1/providers`,
 * curated RAM-tier recommendations included. When that backend isn't running
 * (e.g. `tauri dev` starts Vite without Hono on :8787) the UI would wrongly
 * conclude Ollama isn't installed while the daemon is up. These probes answer
 * "is it there + what's pulled" directly. The curated recommendation still
 * needs the backend.
 */

export interface OllamaDirectProbe {
    /** The daemon answered (version or tags): Ollama is installed + running. */
    installed: boolean;
    version: string | null;
    /** Pulled model names, e.g. 'gemma4:26b'. */
    models: string[];
}

/** GET /ollama/api/version → the running daemon version, or null if unreachable. */
export async function fetchOllamaVersionDirect(): Promise<string | null> {
    try {
        const r = await fetch('/ollama/api/version');
        if (!r.ok) return null;
        const d = (await r.json()) as { version?: string };
        return d.version ?? null;
    } catch {
        return null;
    }
}

/** GET /ollama/api/tags → pulled model names ([] if none or unreachable). */
export async function fetchOllamaModelsDirect(): Promise<string[]> {
    try {
        const r = await fetch('/ollama/api/tags');
        if (!r.ok) return [];
        const d = (await r.json()) as { models?: Array<{ name?: string; model?: string }> };
        return (d.models ?? [])
            .map((m) => m.name ?? m.model ?? '')
            .filter((n): n is string => n.length > 0);
    } catch {
        return [];
    }
}

/** Combined: installed flag + version + pulled models. */
export async function probeOllamaDirect(): Promise<OllamaDirectProbe> {
    const [version, models] = await Promise.all([
        fetchOllamaVersionDirect(),
        fetchOllamaModelsDirect(),
    ]);
    return { installed: version !== null || models.length > 0, version, models };
}
