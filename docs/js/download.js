/* Populate download cards from the latest GitHub release.
 * Falls back to /releases/latest if the API call fails or is rate-limited.
 */

const REPO = 'akrusz/aloud';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const FALLBACK = `https://github.com/${REPO}/releases/latest`;

// Match release asset filenames to platforms. tauri-action emits tauri's
// standard names — `aloud_<version>_<arch>.dmg`, `aloud_<version>_<arch>-setup.exe`
// (NSIS), `aloud_<version>_<arch>.AppImage`. The patterns deliberately exclude
// the updater sidecars also on the release (`.sig`, `.app.tar.gz`, `.msi`,
// `.deb`, `latest.json`) so each card links the right installer.
const PLATFORM_PATTERNS = {
  macos:   /\.dmg$/i,
  windows: /-setup\.exe$/i,
  linux:   /\.AppImage$/i,
};

function detectPlatform() {
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(ua)) return 'macos';
  if (/Windows/.test(ua))         return 'windows';
  if (/Linux|X11/.test(ua))       return 'linux';
  return null;
}

function setVersion(text) {
  const el = document.getElementById('release-version');
  if (el) el.textContent = text;
}

function applyAssets(version, assets) {
  setVersion(`v${version}`);

  for (const [platform, pattern] of Object.entries(PLATFORM_PATTERNS)) {
    const card = document.getElementById(`dl-${platform}`);
    if (!card) continue;
    const asset = assets.find(a => pattern.test(a.name));
    if (asset) {
      card.href = asset.browser_download_url;
      const fileEl = card.querySelector('[data-file]');
      if (fileEl) fileEl.textContent = asset.name;
    }
  }

  // Highlight the visitor's likely platform.
  const detected = detectPlatform();
  if (detected) {
    const card = document.getElementById(`dl-${detected}`);
    if (card) card.setAttribute('data-detected', 'true');
  }
}

function applyFallback() {
  setVersion('latest');
  ['macos', 'windows', 'linux'].forEach(p => {
    const card = document.getElementById(`dl-${p}`);
    if (card) card.href = FALLBACK;
  });
}

async function loadLatest() {
  try {
    const res = await fetch(API_URL, {
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    const version = (data.tag_name || '').replace(/^v/, '');
    applyAssets(version, data.assets || []);
  } catch (err) {
    console.warn('release fetch failed, using fallback:', err);
    applyFallback();
  }
}

loadLatest();

// krusz.eth click-to-copy — matches the About modal behavior in the app.
const ethBtn = document.getElementById('copy-eth');
if (ethBtn) {
  ethBtn.addEventListener('click', () => {
    navigator.clipboard.writeText('krusz.eth').then(() => {
      const original = ethBtn.textContent;
      ethBtn.textContent = 'copied!';
      setTimeout(() => { ethBtn.textContent = original; }, 1500);
    }).catch(err => console.warn('copy failed:', err));
  });
}
