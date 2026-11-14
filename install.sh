#!/bin/sh
# Installs or updates bicycle 42 on a Mac with Apple silicon:
#   curl -fsSL https://raw.githubusercontent.com/kkrll/bicycle42/main/install.sh | sh
# BICYCLE42_VERSION=0.2.0 installs that release; BICYCLE42_DIR=~/Apps installs there.
set -eu

repo=kkrll/bicycle42
app="bicycle 42.app"
asset=bicycle42-mac-arm64.zip

fail() {
  printf 'bicycle 42: %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = Darwin ] || fail "only macOS is supported for now."
# uname -m says x86_64 under Rosetta, so ask the hardware.
[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ] || fail "only Macs with Apple silicon are supported for now."

if [ -n "${BICYCLE42_BASE_URL:-}" ]; then
  base=$BICYCLE42_BASE_URL
elif [ -n "${BICYCLE42_VERSION:-}" ]; then
  base="https://github.com/$repo/releases/download/v${BICYCLE42_VERSION#v}"
else
  base="https://github.com/$repo/releases/latest/download"
fi

if [ -n "${BICYCLE42_DIR:-}" ]; then
  dest=$BICYCLE42_DIR
elif [ -w /Applications ]; then
  dest=/Applications
else
  dest="$HOME/Applications"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

printf 'Downloading bicycle 42…\n'
curl -fSL --progress-bar --retry 3 -o "$tmp/$asset" "$base/$asset" || fail "download failed: $base/$asset"
curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"
(cd "$tmp" && grep " $asset\$" SHA256SUMS | shasum -a 256 -c - >/dev/null) || fail "the download doesn't match its checksum."

ditto -x -k "$tmp/$asset" "$tmp/unpacked"
[ -d "$tmp/unpacked/$app" ] || fail "the download holds no app."
version=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$tmp/unpacked/$app/Contents/Info.plist")

if pgrep -xq "bicycle 42"; then
  printf 'Quitting bicycle 42…\n'
  osascript -e 'quit app "bicycle 42"' >/dev/null 2>&1 || true
  i=0
  while pgrep -xq "bicycle 42"; do
    i=$((i + 1))
    [ "$i" -lt 50 ] || fail "bicycle 42 is still running. Quit it and run this again."
    sleep 0.2
  done
fi

mkdir -p "$dest"
rm -rf "${dest:?}/$app"
ditto "$tmp/unpacked/$app" "$dest/$app"
xattr -dr com.apple.quarantine "$dest/$app" 2>/dev/null || true

printf 'Installed bicycle 42 %s in %s\n' "$version" "$dest"
[ -n "${BICYCLE42_NO_OPEN:-}" ] || open "$dest/$app"
