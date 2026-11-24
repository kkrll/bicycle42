#!/bin/sh
# Installs or updates bicycle 42 on a Mac with Apple silicon:
#   curl -fsSL https://raw.githubusercontent.com/kkrll/bicycle42/main/install.sh | sh
# BICYCLE42_VERSION=0.2.0 installs that release; BICYCLE42_DIR=~/Apps installs there.
set -eu

repo=kkrll/bicycle42
app="bicycle 42.app"
asset=bicycle42-mac-arm64.zip
tmp=
stage=
dest=

fail() {
  printf 'bicycle 42: %s\n' "$*" >&2
  exit 1
}

# However it ends: the old app goes back if no new one took its place, and nothing else stays.
cleanup() {
  if [ -n "$stage" ]; then
    if [ -d "$stage/previous.app" ] && [ ! -e "$dest/$app" ]; then
      mv "$stage/previous.app" "$dest/$app" || { printf 'bicycle 42: the previous app is in %s\n' "$stage" >&2; stage=; }
    fi
    [ -z "$stage" ] || rm -rf "$stage" || true
  fi
  [ -z "$tmp" ] || rm -rf "$tmp" || true
}

# The app opens without Node; only the agents it runs on this Mac need it.
node_note() {
  if ! command -v node >/dev/null 2>&1; then
    found="Node isn't on your PATH."
  else
    major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [ "$major" -lt 22 ] 2>/dev/null; then
      found="this Mac has $(node --version 2>/dev/null || echo 'one that does not run')."
    elif ! command -v npm >/dev/null 2>&1; then
      found="npm isn't on your PATH."
    else
      return 0
    fi
  fi
  printf '\nNote: agents on this Mac need Node 22 or newer with npm, and %s\n' "$found"
  printf 'Get it from https://nodejs.org or your package manager, then open bicycle 42 again.\n'
}

# All of it in a function called on the last line: a download of this script that was cut short
# runs nothing.
main() {
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

  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  tmp=$(mktemp -d)

  printf 'Downloading bicycle 42…\n'
  curl -fSL --progress-bar --retry 3 -o "$tmp/$asset" "$base/$asset" || fail "download failed: $base/$asset"
  curl -fsSL --retry 3 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "download failed: $base/SHA256SUMS"
  (cd "$tmp" && grep " $asset\$" SHA256SUMS | shasum -a 256 -c - >/dev/null) || fail "the download doesn't match its checksum."

  ditto -x -k "$tmp/$asset" "$tmp/unpacked" || fail "the download can't be unpacked."
  [ -d "$tmp/unpacked/$app" ] || fail "the download holds no app."
  version=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$tmp/unpacked/$app/Contents/Info.plist")

  # Copied beside the app first, on the same disk, so that putting it in place is a rename: a copy
  # that fails (a full disk) leaves the app there as it was.
  mkdir -p "$dest"
  stage=$(mktemp -d "$dest/.bicycle42.XXXXXX") || fail "can't write in $dest."
  ditto "$tmp/unpacked/$app" "$stage/$app" || fail "can't copy the app into $dest."
  xattr -dr com.apple.quarantine "$stage/$app" 2>/dev/null || true

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

  if [ -e "$dest/$app" ]; then
    mv "$dest/$app" "$stage/previous.app" || fail "can't replace $dest/$app."
  fi
  mv "$stage/$app" "$dest/$app" || fail "can't put the app in $dest."

  printf 'Installed bicycle 42 %s in %s\n' "$version" "$dest"
  node_note
  [ -n "${BICYCLE42_NO_OPEN:-}" ] || open "$dest/$app"
}

main "$@"
