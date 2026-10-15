/**
 * Hand the user a file the page made. A browser downloads it from a blob link;
 * the app WebViews drop that download without a word, so the mobile app passes
 * the text to its own FileExport plugin instead (FileExportPlugin.java: the
 * system save picker; FileExportPlugin.swift: the share sheet).
 */

import { isCapacitor } from './is-desktop.js';

interface FileExportPlugin {
    save(options: { filename: string; mimeType: string; text: string }): Promise<{ saved: boolean }>;
}

// Never `await` or resolve a promise with this: a Capacitor plugin proxy
// answers every property read, `then` included (screen-dim.ts).
let plugin: FileExportPlugin | null = null;

export async function saveTextFile(filename: string, text: string, mimeType: string): Promise<void> {
    if (isCapacitor()) {
        plugin ??= (await import('@capacitor/core')).registerPlugin<FileExportPlugin>('FileExport');
        await plugin.save({ filename, mimeType, text });
        return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
