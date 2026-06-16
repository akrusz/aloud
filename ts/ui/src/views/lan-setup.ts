/**
 * LAN-setup view — HTTPS upgrade instructions shown when the user hits
 * the HTTP origin from a mobile device that needs a secure context for
 * microphone access.
 *
 * The caller passes the target HTTPS URL to show().
 */

export interface LanSetupViewHandle {
    show(httpsUrl: string): void;
    hide(): void;
}

export function mountLanSetupView(root: HTMLElement): LanSetupViewHandle {
    function render(httpsUrl: string): void {
        root.innerHTML = `
        <div class="main" style="max-width:600px; text-align:center; padding-top:3rem">

            <h2 style="margin-bottom:0.5rem">Almost there</h2>
            <p style="color:var(--text-secondary); margin-bottom:2rem">
                Your browser needs a secure connection for microphone access.
            </p>

            <div style="text-align:left; background:var(--bg-secondary); border-radius:var(--radius);
                        padding:var(--space-lg); margin-bottom:2rem">
                <p style="margin-bottom:1rem">
                    The aloud server created a local security certificate.
                    When you tap the button below your browser will show a
                    <strong>certificate warning</strong> &mdash; this is normal and safe.
                </p>
                <ol style="padding-left:1.25rem; line-height:1.8; margin:0">
                    <li>Tap <strong>Connect securely</strong> below</li>
                    <li>
                        Your browser will warn about the certificate
                        <ul style="padding-left:1rem; list-style:disc; color:var(--text-secondary); font-size:0.9em">
                            <li><b>Chrome / Edge</b> &mdash; tap <em>Advanced</em>, then <em>Proceed</em></li>
                            <li><b>Firefox</b> &mdash; tap <em>Advanced</em>, then <em>Accept the Risk</em></li>
                            <li><b>Safari</b> &mdash; tap <em>visit this website</em>, then confirm</li>
                        </ul>
                    </li>
                    <li>Done &mdash; the warning won't appear again on this device</li>
                </ol>
            </div>

            <a href="${escapeAttr(httpsUrl)}" class="btn btn-primary" style="font-size:1.1rem; padding:0.75rem 2rem">
                Connect securely &rarr;
            </a>

        </div>`;
    }

    return {
        show(httpsUrl: string) {
            render(httpsUrl);
        },
        hide() {
            root.innerHTML = '';
        },
    };
}

function escapeAttr(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
    );
}
