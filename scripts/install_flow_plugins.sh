#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/tdarr/server" >&2
  exit 1
fi

tdarr_root="$1"

if [[ ! -d "$tdarr_root" ]]; then
  echo "Error: '$tdarr_root' is not a directory" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
source_dir="$repo_root/FlowPlugins"
dest_dir="$tdarr_root/Tdarr/Plugins/FlowPlugins"

if [[ ! -d "$source_dir" ]]; then
  echo "Error: source directory not found: $source_dir" >&2
  exit 1
fi

mkdir -p "$dest_dir"

# Only copy plugin entrypoints (index.js), ignore other files
rsync -a \
  --include='*/' \
  --include='index.js' \
  --exclude='*' \
  "$source_dir/" "$dest_dir/"

echo "Installed FlowPlugins into: $dest_dir"
