#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
command -v bun >/dev/null || { echo 'Bun 1.4.2 is required; install it before building.' >&2; exit 1; }
SOURCE_VERSION="$(bun -e 'console.log((await Bun.file("packages/cli/package.json").json()).version)')"
if [[ ! "$SOURCE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid source version: $SOURCE_VERSION" >&2
  exit 1
fi
echo '== install project dependencies =='
bun install --frozen-lockfile
echo '== regression suite =='
(cd packages/core && bun test test/token-economy.test.ts && bun run typecheck)
echo "== build this host target (version $SOURCE_VERSION, local channel) =="
OPENCODE_VERSION="$SOURCE_VERSION" OPENCODE_CHANNEL=local bun run --cwd packages/cli build --single
TARGET="$(find "$ROOT/packages/cli/dist" -type f -path '*/bin/opencode' -print -quit)"
if [[ -z "$TARGET" || ! -x "$TARGET" ]]; then echo 'Build did not produce an executable' >&2; exit 1; fi
BUILT_VERSION="$("$TARGET" --version | sed "s/^opencode v//")"
if [[ "$BUILT_VERSION" != "$SOURCE_VERSION" ]]; then
  echo "Built version mismatch: expected $SOURCE_VERSION, got $BUILT_VERSION" >&2
  exit 1
fi
mkdir -p "$HOME/.local/bin"
install -m 755 "$TARGET" "$HOME/.local/bin/opencode-token-economy"
echo "Installed: $HOME/.local/bin/opencode-token-economy (version $BUILT_VERSION)"
echo 'To make it canonical: bash script/token-economy/install-canonical.sh'
