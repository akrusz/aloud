# Building aloud for Desktop

> **Legacy (PyInstaller).** This is the *original* Python desktop build. The
> desktop app is moving to **Tauri 2** (see [desktop.md](desktop.md)); both CI
> workflows run in parallel for one cycle to validate Tauri before the Python
> cutover (meditation-pal-sk8), after which `build.yml` and this doc go away.
> For current desktop work use Tauri (`cd ts && npm run tauri:build`).

aloud uses PyInstaller to create standalone desktop apps. Each platform must be built on its own OS — PyInstaller doesn't cross-compile.

Releases are fully automated: see `.github/workflows/build.yml`. This doc covers **manual builds** for development.

## Prerequisites (all platforms)

```bash
uv pip install pyinstaller
```

## macOS (.dmg)

```bash
brew install create-dmg
scripts/build-dmg.sh
```

Output: `dist/aloud-{version}-macOS.dmg`

`build-dmg.sh` signs with hardened runtime + entitlements, submits to Apple's notary service, and staples the ticket. One-time setup for signing/notarization is in [dev-cheatsheet.md](dev-cheatsheet.md#macos-signing--notarization-local). For fast iteration, `SKIP_NOTARIZE=1 scripts/build-dmg.sh` skips the (multi-minute) Apple round-trip.

## Windows (.exe)

### Setup

You need a Windows machine (or VM/CI runner) with:

- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- Git (to clone the repo)

```powershell
git clone https://github.com/akrusz/aloud.git
cd aloud
uv pip install -r requirements.txt
uv pip install pyinstaller
```

### Build

`aloud.spec` already handles per-platform icon selection and skips the macOS-only `BUNDLE(...)` block on Windows. The committed `assets/aloud.ico` is used automatically.

```powershell
uv run pyinstaller aloud.spec --noconfirm
```

Output: `dist/aloud/aloud.exe` (a folder with the exe + supporting files)

### Package

For a single-folder distribution, zip it up:

```powershell
$version = python -c "import re; print(re.search('__version__\s*=\s*\x22(.+?)\x22', (Get-Content src/__init__.py -Raw)).Groups[1].Value)"
Compress-Archive -Path dist\aloud -DestinationPath "dist\aloud-$version-win.zip"
```

For a proper installer, use [NSIS](https://nsis.sourceforge.io/) or [Inno Setup](https://jrsoftware.org/isinfo.php). A minimal Inno Setup script:

```iss
[Setup]
AppName=aloud
AppVersion={#Version}
DefaultDirName={autopf}\aloud
DefaultGroupName=aloud
OutputBaseFilename=aloud-{#Version}
Compression=lzma2
SolidCompression=yes

[Files]
Source: "dist\aloud\*"; DestDir: "{app}"; Flags: recursesubdirs

[Icons]
Name: "{group}\aloud"; Filename: "{app}\aloud.exe"
Name: "{autodesktop}\aloud"; Filename: "{app}\aloud.exe"
```

### Platform notes

- **TTS**: The `macos` engine won't work. Default config should be `browser` or `piper` on Windows. Users can also use `elevenlabs`.
- **pywebview**: Uses EdgeChromium (WebView2) on Windows. It's bundled with Windows 11 and most Windows 10 installs. If missing, pywebview falls back to MSHTML.
- **Microphone**: No special permissions needed on Windows — the OS prompts the user.

## Linux (.AppImage)

### Setup

Build on an Ubuntu/Debian machine (or CI runner like `ubuntu-latest`):

```bash
git clone https://github.com/akrusz/aloud.git
cd aloud
uv pip install -r requirements.txt
uv pip install pyinstaller
```

Linux dependencies for pywebview and audio:

```bash
# pywebview (GTK/WebKit backend)
sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-webkit2-4.1

# Audio (PyAudio / PortAudio)
sudo apt install portaudio19-dev python3-pyaudio
```

### Build

```bash
uv run pyinstaller aloud.spec --noconfirm
```

Output: `dist/aloud/` folder. The committed `assets/aloud.png` is used by the AppImage packaging step below.

### Package as AppImage

Install [appimagetool](https://github.com/AppImage/appimagetool):

```bash
wget -O appimagetool https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
chmod +x appimagetool
```

Create the AppDir structure:

```bash
VERSION=$(python3 -c "import re; print(re.search(r'__version__\s*=\s*\"(.+?)\"', open('src/__init__.py').read()).group(1))")

mkdir -p aloud.AppDir/usr/bin
cp -r dist/aloud/* aloud.AppDir/usr/bin/
cp assets/aloud.png aloud.AppDir/aloud.png

# Desktop entry
cat > aloud.AppDir/aloud.desktop << 'EOF'
[Desktop Entry]
Name=aloud
Exec=aloud
Icon=aloud
Type=Application
Categories=Utility;
EOF

# AppRun launcher
cat > aloud.AppDir/AppRun << 'APPRUN'
#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/aloud" "$@"
APPRUN
chmod +x aloud.AppDir/AppRun

# Build
./appimagetool aloud.AppDir "dist/aloud-${VERSION}.AppImage"
```

### Platform notes

- **TTS**: `macos` engine won't work. Use `browser`, `piper` (works great on Linux), or `elevenlabs`.
- **pywebview**: Uses GTK+WebKit. Needs the system packages listed above.
- **Microphone**: PulseAudio or PipeWire must be running (standard on modern distros).

## CI/CD

Releases run through `.github/workflows/build.yml`, triggered when `scripts/release.sh` creates a GitHub release. Three parallel jobs:

- **macOS** — runs `scripts/build-dmg.sh` with the signing keychain set up from secrets. Output is a signed + notarized `.dmg`.
- **Windows** — builds via PyInstaller and packages with Inno Setup (`iscc`) into a `.exe` installer.
- **Linux** — builds via PyInstaller and packages with `appimagetool` into an `.AppImage`.

All three upload artifacts to the GitHub Release via `softprops/action-gh-release@v2`.

macOS signing secrets and the certificate-import dance are documented in [dev-cheatsheet.md](dev-cheatsheet.md#macos-signing--notarization-ci).

## Asset naming for auto-updates

The in-app update system matches assets by suffix:

| Platform | Filename |
|----------|----------|
| macOS    | `aloud-{version}-macOS.dmg` |
| Windows  | `aloud-{version}-Windows.exe` |
| Linux    | `aloud-{version}-Linux.AppImage` |

Attach these to a GitHub Release tagged `v{version}` and the app will detect and offer the update.
