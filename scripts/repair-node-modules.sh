#!/usr/bin/env bash
# Repair local node_modules for the pnpm-linked dsh-voice-mimo bundle.
# Symlinks peers to the shared flat fallback so the bundle shares one
# instance with the running harness (no duplicate cordis/react).
set -euo pipefail
HERE="$(cd "$(dirname "$(dirname "$0")")" && pwd)"
FALLBACK="${DSH_HOME:-$HOME/.dsh}/profiles/node_modules"
NM="$HERE/node_modules"
rm -rf "$NM"
mkdir -p "$NM/@deepseek-ai"
for p in dsh-settings dsh-tools schemastery cordis cosmokit dsh-home-paths; do
  ln -sfn "$FALLBACK/@deepseek-ai/$p" "$NM/@deepseek-ai/$p"
done
echo "dsh-voice-mimo node_modules repaired"
node -e "import('file://$HERE/lib/index.js').then(m => console.log('host OK:', Object.keys(m).join(',')))"
