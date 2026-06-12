#!/usr/bin/env bash
# Install caesar-search from the latest GitHub release.
#   curl -fsSL https://raw.githubusercontent.com/caesar-data/caesar-search-cli/main/install.sh | bash
set -euo pipefail

REPO="caesar-data/caesar-search-cli"
INSTALL_DIR="${CAESAR_INSTALL_DIR:-$HOME/.local/bin}"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) echo "unsupported OS: $os (download manually from https://github.com/$REPO/releases)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) cpu="amd64" ;;
  arm64|aarch64) cpu="arm64" ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac

tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)"
[ -n "$tag" ] || { echo "could not determine latest release" >&2; exit 1; }
version="${tag#v}"

archive="caesar-search_${version}_${platform}_${cpu}.tar.gz"
base="https://github.com/$REPO/releases/download/$tag"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "downloading caesar-search $tag ($platform/$cpu)..." >&2
curl -fsSL -o "$tmp/$archive" "$base/$archive"
curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"

(cd "$tmp" && grep " $archive\$" checksums.txt | shasum -a 256 -c - >/dev/null) \
  || { echo "checksum verification failed" >&2; exit 1; }

tar -xzf "$tmp/$archive" -C "$tmp"
mkdir -p "$INSTALL_DIR"
install -m 0755 "$tmp/caesar-search" "$INSTALL_DIR/caesar-search"

echo "installed caesar-search $tag to $INSTALL_DIR/caesar-search" >&2
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "note: add $INSTALL_DIR to your PATH" >&2 ;;
esac
