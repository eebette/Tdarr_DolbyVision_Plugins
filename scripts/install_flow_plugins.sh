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

repo_url="https://github.com/eebette/Tdarr_DolbyVision_Plugins/archive/refs/heads/main.tar.gz"
tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

archive_path="$tmp_dir/repo.tar.gz"

if command -v curl >/dev/null 2>&1; then
  echo "Downloading plugins archive with curl..."
  curl -L "$repo_url" -o "$archive_path"
elif command -v wget >/dev/null 2>&1; then
  echo "Downloading plugins archive with wget..."
  wget -O "$archive_path" "$repo_url"
else
  echo "Error: need curl or wget to download $repo_url" >&2
  exit 1
fi

echo "Extracting archive..."
tar -xzf "$archive_path" -C "$tmp_dir"

# Locate FlowPlugins directory inside the extracted tree
source_dir="$(find "$tmp_dir" -maxdepth 2 -type d -name FlowPlugins | head -n 1 || true)"
if [[ -z "$source_dir" || ! -d "$source_dir" ]]; then
  echo "Error: source directory not found after extract." >&2
  exit 1
fi

dest_dir="$tdarr_root/Tdarr/Plugins/FlowPlugins"

mkdir -p "$dest_dir"

# Only copy plugin entrypoints (index.js), ignore other files
rsync -a \
  --include='*/' \
  --include='index.js' \
  --exclude='*' \
  "$source_dir/" "$dest_dir/"

echo "Installed FlowPlugins into: $dest_dir"
