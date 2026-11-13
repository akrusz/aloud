/**
 * A model id read as a version of a line: `claude-opus-4-8` and
 * `claude-opus-5-5` are 4.8 and 5.5 of `claude-opus`, `gpt-5.6-sol` and
 * `gpt-6-sol` are 5.6 and 6 of `gpt-sol`. The hosted picker uses it to move a
 * saved pick that has left the shortlist onto the line's newer version
 * (ui/src/model-picker.ts lineSuccessor).
 *
 * Read off the id, not kept in a table, because the id that needs it most is
 * one the catalog no longer has: a pick saved on a device before its model
 * was delisted.
 */
export interface ModelLine {
    /** The id with its version taken out. Whatever prefix the caller passed
     *  (`anthropic/…`) stays in, so lines never match across providers. */
    line: string;
    /** [major, minor], compared in that order: 5.10 is after 5.9. */
    version: readonly [number, number];
}

/** Null when the id carries no version as a part of its own (`kimi-k2`):
 *  such a model has no line to follow and takes the picker's default path. */
export function modelLine(id: string): ModelLine | null {
    // A trailing date stamp is a snapshot of the version, not part of it.
    const parts = id.toLowerCase().replace(/[-_]\d{6,8}$/, '').split('-');
    const at = parts.findIndex((p) => /^\d+(\.\d+)?$/.test(p));
    if (at === -1) return null;
    const [major = 0, dotted] = parts[at]!.split('.').map(Number);
    let minor = dotted ?? 0;
    let taken = 1;
    // Anthropic writes the minor as a part of its own: opus-5-5.
    const next = parts[at + 1];
    if (dotted === undefined && next !== undefined && /^\d{1,2}$/.test(next)) {
        minor = Number(next);
        taken = 2;
    }
    const line = [...parts.slice(0, at), ...parts.slice(at + taken)].join('-');
    if (!line) return null;
    return { line, version: [major, minor] };
}

/** Negative when `a` is the older version, positive when the newer. */
export function compareVersions(a: ModelLine['version'], b: ModelLine['version']): number {
    return a[0] - b[0] || a[1] - b[1];
}
