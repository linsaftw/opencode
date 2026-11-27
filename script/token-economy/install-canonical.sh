#!/usr/bin/env bash
# Promote the verified standalone local build without touching OpenCode user data.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE="${1:-$HOME/.local/bin/opencode-token-economy}"
DEST="$HOME/.local/bin/opencode"
EXPECTED="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)".*/\1/p' "$ROOT/packages/cli/package.json" | head -n 1)"
if [[ ! -f "$SOURCE" || ! -x "$SOURCE" ]]; then
  echo "Missing built executable: $SOURCE" >&2
  echo 'Run bash script/token-economy/build-install.sh first.' >&2
  exit 1
fi
ACTUAL="$("$SOURCE" --version)"
if [[ -z "$EXPECTED" || "$ACTUAL" != "$EXPECTED" ]]; then
  echo "Refusing to install version $ACTUAL; expected $EXPECTED." >&2
  exit 1
fi
mkdir -p "$HOME/.local/bin"
if [[ "$SOURCE" -ef "$DEST" ]] || { [[ -f "$DEST" ]] && cmp -s -- "$SOURCE" "$DEST"; }; then
  echo "Already installed: $DEST ($ACTUAL)"
  exit 0
fi
if [[ -e "$DEST" || -L "$DEST" ]]; then
  BACKUP="$DEST.backup-$(date +%Y%m%d%H%M%S)-$$"
  cp -a -- "$DEST" "$BACKUP"
  echo "Previous ~/.local/bin/opencode saved as: $BACKUP"
fi
TEMP="$(mktemp "$HOME/.local/bin/.opencode.new.XXXXXXXX")"
trap 'rm -f -- "$TEMP"' EXIT
install -m 755 -- "$SOURCE" "$TEMP"
if [[ "$("$TEMP" --version)" != "$EXPECTED" ]]; then
  echo 'Staged executable failed its version check.' >&2
  exit 1
fi
mv -f -- "$TEMP" "$DEST"
trap - EXIT
if [[ "${SHELL:-}" == */zsh ]]; then
  RC="${ZDOTDIR:-$HOME}/.zshrc"
  LINE='export PATH="$HOME/.local/bin:$PATH"'
  if ! grep -qxF "$LINE" "$RC" 2>/dev/null; then
    printf '\n# Prefer locally built OpenCode without changing package-managed binaries.\n%s\n' "$LINE" >> "$RC"
    echo "PATH preference added to $RC"
  fi
fi
echo "Installed canonical executable: $DEST ($ACTUAL)"
echo 'Current terminal: export PATH="$HOME/.local/bin:$PATH"; rehash'
echo 'Verify: command -v opencode; opencode --version'
echo 'Existing ~/.config/opencode, ~/.local/share/opencode, ~/.local/state/opencode were not modified.'
