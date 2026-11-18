/**
 * A stand-in for HTMLAudioElement, enough for the sound player: play() and
 * pause() as a browser runs them (pause fires its event on a later task), a
 * volume an iPhone puts back, and a log of every play() across elements.
 */

export interface PlayRecord {
    el: FakeAudio;
    src: string;
    muted: boolean;
    currentTime: number;
}

export class FakeAudio {
    static made: FakeAudio[] = [];
    static log: PlayRecord[] = [];
    /** Replaces what play() returns: a rejection, or a promise that never settles. */
    static playResult: (() => Promise<void>) | null = null;
    /** An iPhone: a volume set is taken, then put back to 1 on a later task. */
    static volumeFixed = false;

    static reset(): void {
        FakeAudio.made = [];
        FakeAudio.log = [];
        FakeAudio.playResult = null;
        FakeAudio.volumeFixed = false;
    }

    preload = '';
    muted = false;
    paused = true;
    ended = false;
    error: { code: number } | null = null;
    networkState = 1;
    currentTime = 0;
    duration = 4;
    srcSets = 0;
    pauses = 0;
    private _src = '';
    private _volume = 1;
    private readonly listeners = new Map<string, Set<() => void>>();

    constructor(src?: string) {
        if (src) this._src = src;
        FakeAudio.made.push(this);
    }

    get src(): string {
        return this._src;
    }
    set src(value: string) {
        this._src = value;
        this.srcSets++;
        this.currentTime = 0;
        this.ended = false;
    }

    get volume(): number {
        return this._volume;
    }
    set volume(value: number) {
        this._volume = value;
        if (FakeAudio.volumeFixed) setTimeout(() => (this._volume = 1), 0);
    }

    play(): Promise<void> {
        if (this.ended) {
            this.currentTime = 0;
            this.ended = false;
        }
        this.paused = false;
        FakeAudio.log.push({ el: this, src: this._src, muted: this.muted, currentTime: this.currentTime });
        return FakeAudio.playResult ? FakeAudio.playResult() : Promise.resolve();
    }

    pause(): void {
        if (this.paused) return;
        this.paused = true;
        this.pauses++;
        setTimeout(() => this.fire('pause'), 0);
    }

    /** Played out: pause then ended, as a browser fires them. */
    end(): void {
        this.paused = true;
        this.ended = true;
        this.currentTime = this.duration;
        this.fire('pause');
        this.fire('ended');
    }

    fire(type: string): void {
        for (const handler of [...(this.listeners.get(type) ?? [])]) handler();
    }

    addEventListener(type: string, handler: () => void): void {
        let set = this.listeners.get(type);
        if (!set) this.listeners.set(type, (set = new Set()));
        set.add(handler);
    }

    removeEventListener(type: string, handler: () => void): void {
        this.listeners.get(type)?.delete(handler);
    }

    listening(type: string): number {
        return this.listeners.get(type)?.size ?? 0;
    }
}

/** Plays that could be heard: not a prime's silence, not muted. */
export function audiblePlays(): PlayRecord[] {
    return FakeAudio.log.filter((p) => !p.muted && !p.src.startsWith('data:'));
}
