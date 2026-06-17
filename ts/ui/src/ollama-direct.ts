/**
 * Direct probes to the local Ollama daemon via the `/ollama` dev proxy — the
 * same path capabilities.ts uses for reachability (Vite rewrites `/ollama` →
 * http://localhost:11434).
 *
 * The app backend (the Rust backend in the desktop app, Hono on the web and in
 * browser dev) normally aggregates Ollama state at `/app/v1/providers`,
 * including the curated RAM-tier recommendations. But when that backend isn't
 * running — e.g. `tauri dev` starts Vite without the Hono server on :8787 —
 * that endpoint is unreachable and the UI would wrongly conclude Ollama isn't
 * installed even
 * though the daemon is up. These probes answer the basic "is it there + what's
 * pulled" questions directly so the model picker and settings section stay
 * honest without the backend. The curated recommendation still needs it.
 */

export interface OllamaDirectProbe {
    /** The daemon answered (version or tags) — i.e. Ollama is installed + running. */
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

/** Combined probe: installed flag + version + pulled models, all via /ollama. */
export async function probeOllamaDirect(): Promise<OllamaDirectProbe> {
    const [version, models] = await Promise.all([
        fetchOllamaVersionDirect(),
        fetchOllamaModelsDirect(),
    ]);
    return { installed: version !== null || models.length > 0, version, models };
}
