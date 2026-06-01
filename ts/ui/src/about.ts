/**
 * About modal wiring — lifted from src/web/static/js/chrome.js.
 *
 * Brand link toggles open/close, × closes, click outside closes. The
 * krusz.eth span reveals a small crypto panel (QR + copyable address +
 * accepted chains); the address button copies the full 0x address. We copy
 * the raw address rather than the ENS name on purpose — krusz.eth only
 * resolves on Ethereum mainnet, so the name would fail in a Base wallet,
 * whereas the bare address works on any chain the sender picks. Update
 * checker omitted intentionally — that's desktop-app-specific and the
 * TS preview has no equivalent self-update story yet.
 */

// krusz.eth, resolved. The QR (ts/ui/public/krusz-eth-qr.svg) encodes this
// same bare address, so a scan and a copy land in the same place.
const DONATE_ADDRESS = '0x7895267268918407d14a7F37f2C4035BA985E2Ca';

export function initAbout(): void {
    const brand = document.getElementById('aboutLink');
    const modal = document.getElementById('aboutModal');
    const close = document.getElementById('aboutClose');
    const ethEl = document.querySelector<HTMLElement>('.about-eth');
    const crypto = document.getElementById('aboutCrypto');
    const addrBtn = document.getElementById('aboutCryptoAddr');
    if (!brand || !modal || !close) return;

    // Hiding the modal also collapses the crypto panel, so it re-opens clean.
    const hide = () => {
        modal.classList.add('hidden');
        crypto?.classList.add('hidden');
    };

    brand.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        modal.classList.toggle('hidden');
    });
    close.addEventListener('click', hide);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) hide();
    });

    if (ethEl && crypto) {
        ethEl.addEventListener('click', () => crypto.classList.toggle('hidden'));
    }

    if (addrBtn) {
        const label = addrBtn.textContent;
        addrBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(DONATE_ADDRESS).then(() => {
                addrBtn.textContent = 'copied!';
                setTimeout(() => {
                    addrBtn.textContent = label;
                }, 1500);
            });
        });
    }
}
