# Canonical build

- Running service: `~/.local/bin/opencode serve --service` (v2.4.1), listening on 127.0.0.1:49374.
- Source: this repo (`linsaftw/opencode`, branch `token-economy`). Build and install with
  `script/token-economy/install-canonical.sh`; no binary backups are kept (user order).
- Delegation bridge: `ArkFlame/claude-opencode-mcp` (separate repo, installed by `npm link`; build with `npm run build`).
