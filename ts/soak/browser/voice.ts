/**
 * The simulated meditator's mouth (tier 2). Tier 1 hands the engine a string;
 * tier 2 has to make a sound the app's microphone can hear, so every sim
 * utterance is synthesized and played out of the machine's current default
 * output device - which the harness has pointed at BlackHole (audio.ts).
 *
 * `say` is the default: free, offline, instant, and its Siri voices transcribe
 * well. The interface exists so a run can be repeated through the same hosted
 * voices the app itself uses when we want the recognizer to face realistic
 * prosody - the STT numbers from a `say` run and an `openai` run are not
 * comparable, which is exactly why the spec is recorded in the report.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SimVoice {
    /** How this voice is named in the report. */
    readonly id: string;
    /** Synthesize and play `text`, resolving when the audio has finished. */
    speak(text: string): Promise<void>;
    /** Release any scratch space. */
    close(): Promise<void>;
}

function run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(0, 200)}`));
        });
    });
}

/** macOS `say`, straight to the default output device. */
class SayVoice implements SimVoice {
    readonly id: string;
    private readonly voiceName: string | null;
    private readonly rate: number | null;

    constructor(voiceName: string | null, rate: number | null) {
        this.voiceName = voiceName;
        this.rate = rate;
        this.id = `say${voiceName ? `:${voiceName}` : ''}`;
    }

    async speak(text: string): Promise<void> {
        const args: string[] = [];
        if (this.voiceName) args.push('-v', this.voiceName);
        if (this.rate) args.push('-r', String(this.rate));
        args.push('--', text);
        await run('say', args);
    }

    async close(): Promise<void> {}
}

/**
 * OpenAI gpt-4o-mini-tts - the same engine behind the app's hosted voices - to
 * a temp file, played with afplay. Costs money per utterance; opt in with
 * --voice=openai[:<voice>].
 */
class OpenAiVoice implements SimVoice {
    readonly id: string;
    private readonly voiceName: string;
    private dir: string | null = null;
    private counter = 0;

    constructor(voiceName: string) {
        this.voiceName = voiceName;
        this.id = `openai:${voiceName}`;
    }

    async speak(text: string): Promise<void> {
        const key = process.env.OPENAI_API_KEY;
        if (!key) throw new Error('OPENAI_API_KEY is required for --voice=openai (set it or fill ts/server/.env)');
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'gpt-4o-mini-tts',
                voice: this.voiceName,
                input: text,
                response_format: 'wav',
            }),
        });
        if (!res.ok) {
            throw new Error(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        this.dir ??= await mkdtemp(join(tmpdir(), 'aloud-soak-voice-'));
        const path = join(this.dir, `${this.counter++}.wav`);
        await writeFile(path, Buffer.from(await res.arrayBuffer()));
        try {
            await run('afplay', [path]);
        } finally {
            await rm(path, { force: true });
        }
    }

    async close(): Promise<void> {
        if (this.dir) await rm(this.dir, { recursive: true, force: true });
    }
}

/** Records everything and plays nothing - for exercising the driver offline. */
class SilentVoice implements SimVoice {
    readonly id = 'silent';
    async speak(): Promise<void> {}
    async close(): Promise<void> {}
}

/**
 * Build a voice from a CLI spec: "say", "say:Samantha", "say:Samantha@170",
 * "openai", "openai:sage", "silent".
 */
export function buildSimVoice(spec: string): SimVoice {
    const sep = spec.indexOf(':');
    const name = sep === -1 ? spec : spec.slice(0, sep);
    const arg = sep === -1 ? '' : spec.slice(sep + 1);
    switch (name) {
        case 'say': {
            const [voiceName, rate] = arg.split('@');
            return new SayVoice(voiceName || null, rate ? Number(rate) : null);
        }
        case 'openai':
            return new OpenAiVoice(arg || 'sage');
        case 'silent':
            return new SilentVoice();
        default:
            throw new Error(`Unknown voice "${name}". Use one of: say, openai, silent (optionally ":<voice>").`);
    }
}
