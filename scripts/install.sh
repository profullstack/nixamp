#!/bin/sh
# nixamp installer.
#
#   curl -fsSL https://nixamp.com/install.sh | sh
#
# Installs the CLI always, and the desktop app when this machine has a desktop
# to run it on. Everything lands under your home directory: no root, no package
# manager, no system files touched. Updating is `nixamp update` and removing is
# `nixamp uninstall`, which runs a script this installer leaves behind.
#
#   sh -s -- --cli-only     never install the desktop app
#   sh -s -- --desktop      install it even with no desktop session detected
#   sh -s -- --version X    install a specific release
#   sh -s -- --prefix DIR   install root (default: ~/.local)
set -eu

REPO="profullstack/nixamp"
SITE="${NIXAMP_SITE:-https://nixamp.com}"
PREFIX="${NIXAMP_PREFIX:-$HOME/.local}"
VERSION="${NIXAMP_VERSION:-}"
WANT_DESKTOP=auto

while [ $# -gt 0 ]; do
  case "$1" in
    --cli-only) WANT_DESKTOP=no ;;
    --desktop)  WANT_DESKTOP=yes ;;
    --version)  VERSION="${2:?--version needs a value}"; shift ;;
    --prefix)   PREFIX="${2:?--prefix needs a value}"; shift ;;
    -h|--help)  sed -n '2,15p' "$0" 2>/dev/null || echo "See $SITE"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- what are we on -----------------------------------------------------------

case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) fail "unsupported operating system: $(uname -s). nixamp supports Linux and macOS." ;;
esac

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)." ;;
esac

if command -v curl >/dev/null 2>&1; then
  fetch()   { curl -fsSL "$1"; }
  download(){ curl -fsSL --progress-bar -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch()   { wget -qO- "$1"; }
  download(){ wget -q --show-progress -O "$2" "$1"; }
else
  fail "curl or wget is required."
fi

command -v tar >/dev/null 2>&1 || fail "tar is required."

# A desktop app needs a desktop. Over SSH into a server there is nothing to
# show it on, and pulling 100MB of Electron onto a box that will never run it
# is not a kindness.
has_desktop_session() {
  [ "$OS" = darwin ] && return 0
  [ -n "${DISPLAY:-}" ] && return 0
  [ -n "${WAYLAND_DISPLAY:-}" ] && return 0
  [ -n "${XDG_CURRENT_DESKTOP:-}" ] && return 0
  return 1
}

if [ "$WANT_DESKTOP" = auto ]; then
  if has_desktop_session; then WANT_DESKTOP=yes; else WANT_DESKTOP=no; fi
fi

# --- which release ------------------------------------------------------------

if [ -z "$VERSION" ]; then
  VERSION=$(fetch "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$VERSION" ] || fail "could not determine the latest version. Pass --version, or see $SITE"
fi

# Overridable so the installer can be exercised against a local release
# rather than only in production, which is the one place you cannot rehearse.
BASE="${NIXAMP_RELEASE_BASE:-https://github.com/$REPO/releases/download/v$VERSION}"
SHARE="$PREFIX/share/nixamp"
BIN="$PREFIX/bin"

say "nixamp $VERSION"
say "  platform:  $OS-$ARCH"
say "  desktop:   $WANT_DESKTOP"
say "  prefix:    $PREFIX"
say ""

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

mkdir -p "$SHARE" "$BIN"
PATHS="$BIN/nixamp
$SHARE"
METHOD=cli-tarball

# --- the desktop app ----------------------------------------------------------

if [ "$WANT_DESKTOP" = yes ]; then
  if [ "$OS" = linux ]; then
    ASSET="nixamp-$VERSION-linux-$ARCH.tar.gz"
    say "Downloading the desktop app..."
    if download "$BASE/$ASSET" "$WORK/app.tar.gz"; then
      rm -rf "$SHARE/app"
      mkdir -p "$SHARE/app"
      # --strip-components=1: the archive holds a single top-level directory.
      tar -xzf "$WORK/app.tar.gz" -C "$SHARE/app" --strip-components=1
      METHOD=linux-app

      # Electron needs a sandbox it is allowed to use. Where the SUID helper
      # did not survive the tarball, and unprivileged user namespaces are
      # restricted, starting without the sandbox beats not starting at all.
      cat > "$SHARE/app/launch.sh" <<'LAUNCH'
#!/bin/sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
app="$here/nixamp"
if [ -u "$here/chrome-sandbox" ]; then
  exec "$app" "$@"
fi
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ] \
  || ! unshare --user true >/dev/null 2>&1; then
  echo "nixamp: no usable Chromium sandbox here; starting without it." >&2
  exec "$app" --no-sandbox "$@"
fi
exec "$app" "$@"
LAUNCH
      chmod 0755 "$SHARE/app/launch.sh"

      # A launcher, an icon and a menu entry: what a .deb would give you, done
      # by hand because doing it by hand needs no root.
      mkdir -p "$PREFIX/share/applications" "$PREFIX/share/icons/hicolor/512x512/apps"
      [ -f "$SHARE/app/resources/icon.png" ] &&
        cp "$SHARE/app/resources/icon.png" "$PREFIX/share/icons/hicolor/512x512/apps/nixamp.png"

      cat > "$PREFIX/share/applications/nixamp.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=nixamp
GenericName=Media Player
Comment=It really whips the terminal's ass.
Exec=$SHARE/app/launch.sh %U
Icon=nixamp
Terminal=false
StartupWMClass=nixamp
Categories=AudioVideo;Audio;Player;
Keywords=music;audio;player;winamp;terminal;
DESKTOP

      command -v update-desktop-database >/dev/null 2>&1 &&
        update-desktop-database "$PREFIX/share/applications" >/dev/null 2>&1 || true

      PATHS="$PATHS
$PREFIX/share/applications/nixamp.desktop
$PREFIX/share/icons/hicolor/512x512/apps/nixamp.png"
    else
      say "  the desktop app is not published for $OS-$ARCH at $VERSION; installing the CLI only."
      WANT_DESKTOP=no
    fi

  else
    ASSET="nixamp-$VERSION-mac-$ARCH.zip"
    say "Downloading the desktop app..."
    if command -v unzip >/dev/null 2>&1 && download "$BASE/$ASSET" "$WORK/app.zip"; then
      APPS="$HOME/Applications"
      mkdir -p "$APPS"
      rm -rf "$APPS/nixamp.app"
      unzip -q "$WORK/app.zip" -d "$APPS"
      METHOD=macos-app
      PATHS="$PATHS
$APPS/nixamp.app"
    else
      say "  the desktop app could not be installed; installing the CLI only."
      WANT_DESKTOP=no
    fi
  fi
fi

# --- the CLI ------------------------------------------------------------------
#
# A desktop install already contains it, and that copy runs on the Node inside
# Electron, so no system Node is needed. Without the desktop, the CLI comes as
# its own bundle and does need one.

if [ "$METHOD" = linux-app ]; then
  CLI_DIR="$SHARE/app/resources/cli"
  RUNTIME="$SHARE/app/nixamp"
elif [ "$METHOD" = macos-app ]; then
  CLI_DIR="$HOME/Applications/nixamp.app/Contents/Resources/cli"
  RUNTIME="$HOME/Applications/nixamp.app/Contents/MacOS/nixamp"
else
  # Pure JavaScript, so one bundle runs everywhere a Node does.
  ASSET="nixamp-cli-$VERSION.tar.gz"
  say "Downloading the CLI..."
  download "$BASE/$ASSET" "$WORK/cli.tar.gz" || fail "could not download $BASE/$ASSET"

  rm -rf "$SHARE/cli"
  mkdir -p "$SHARE/cli"
  tar -xzf "$WORK/cli.tar.gz" -C "$SHARE/cli" --strip-components=1
  CLI_DIR="$SHARE/cli"
  RUNTIME=""

  command -v node >/dev/null 2>&1 ||
    say "  note: no desktop app was installed, so the CLI needs Node 24 or newer. It was not found."
fi

# The shim. Written here rather than shipped, because only the installer knows
# which of the two runtimes this machine ended up with.
if [ -n "$RUNTIME" ]; then
  cat > "$BIN/nixamp" <<SHIM
#!/bin/sh
# nixamp. Runs on the Node inside the desktop app, so no system Node is
# required. Written by the installer; \`nixamp uninstall\` removes it.
NIXAMP_HOME="$SHARE" ELECTRON_RUN_AS_NODE=1 exec "$RUNTIME" "$CLI_DIR/bin/nixamp.mjs" "\$@"
SHIM
else
  cat > "$BIN/nixamp" <<SHIM
#!/bin/sh
# nixamp. Written by the installer; \`nixamp uninstall\` removes it.
command -v node >/dev/null 2>&1 || {
  echo "nixamp: node 24 or newer is required for a CLI-only install." >&2
  exit 69
}
NIXAMP_HOME="$SHARE" exec node "$CLI_DIR/bin/nixamp.mjs" "\$@"
SHIM
fi
chmod 0755 "$BIN/nixamp"

# --- what was installed, and how to remove it ---------------------------------

INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DESKTOP_FLAG=false
[ "$WANT_DESKTOP" = yes ] && DESKTOP_FLAG=true

{
  printf '{\n'
  printf '  "version": "%s",\n' "$VERSION"
  printf '  "method": "%s",\n' "$METHOD"
  printf '  "installer": "%s/install.sh",\n' "$SITE"
  printf '  "installedAt": "%s",\n' "$INSTALLED_AT"
  printf '  "prefix": "%s",\n' "$PREFIX"
  printf '  "desktop": %s,\n' "$DESKTOP_FLAG"
  printf '  "paths": [\n'
  printf '%s\n' "$PATHS" | sed 's/.*/    "&",/' | sed '$ s/,$//'
  printf '  ]\n}\n'
} > "$SHARE/manifest.json"

{
  echo '#!/bin/sh'
  echo '# Removes nixamp. Written by the installer, which knew exactly what it created.'
  echo '# Your music is NOT touched.'
  echo 'set -eu'
  printf '%s\n' "$PATHS" | sed 's|.*|rm -rf "&"|'
  echo 'echo "nixamp removed."'
} > "$SHARE/uninstall.sh"
chmod 0755 "$SHARE/uninstall.sh"

# --- report -------------------------------------------------------------------

say ""
say "Installed nixamp $VERSION"
if [ "$WANT_DESKTOP" = yes ]; then say "  desktop app and CLI"; else say "  CLI only (no desktop session detected)"; fi

# ffmpeg decodes every track. Saying so now beats a confusing failure on first
# use, when the playlist loads and nothing comes out of the speakers.
if ! command -v ffmpeg >/dev/null 2>&1; then
  say ""
  say "  ffmpeg was not found, and nixamp decodes with ffmpeg."
  say "  Debian/Ubuntu:  sudo apt install ffmpeg"
  say "  macOS:          brew install ffmpeg"
fi

case ":$PATH:" in
  *":$BIN:"*)
    say ""
    say "Try:  nixamp ~/Music"
    ;;
  *)
    say ""
    say "$BIN is not on your PATH. Add it:"
    say "  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.profile && . ~/.profile"
    say ""
    say "Or run it directly:  $BIN/nixamp ~/Music"
    ;;
esac

say ""
say "Update with \`nixamp update\`, remove with \`nixamp uninstall\`."
say "Docs: $SITE"
