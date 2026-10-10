#!/bin/sh
# Install tunnel, an end-to-end encrypted tunnel between AI agents on different machines.
#
#   curl -fsSL https://tunnel.dilyor.dev/install.sh | sh
#
# Everything goes in ~/.tunnel: bin/tunnel, lib/tunnel-ai, and node/ when this machine
# has no Node 22.13 or newer. Run it again to update.
# Uninstall: rm -rf ~/.tunnel/bin ~/.tunnel/lib ~/.tunnel/node
#
#   TUNNEL_INSTALL=/some/dir      install somewhere else
#   TUNNEL_NO_MODIFY_PATH=1       leave shell profiles alone

set -eu

BASE="${TUNNEL_DOWNLOAD:-https://tunnel.dilyor.dev}"
NODE_DIST="https://nodejs.org/dist/latest-v22.x"

say() { printf '%s\n' "$*"; }
die() {
  printf 'tunnel install: %s\n' "$*" >&2
  exit 1
}

fetch() { # url file
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "needs curl or wget"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

# tunnel needs node:sqlite without flags, which arrived in Node 22.13.
node_ok() { "$1" --no-warnings -e 'require("node:sqlite")' >/dev/null 2>&1; }

pretty() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Prints the nodejs.org platform name, e.g. linux-x64 or darwin-arm64.
platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux) os=linux ;;
    Darwin)
      os=darwin
      # A shell running under Rosetta reports x86_64 on Apple silicon.
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
      ;;
    *) die "no prebuilt Node for $os. Install Node 22.13+ yourself, then run this again." ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) die "no prebuilt Node for $arch. Install Node 22.13+ yourself, then run this again." ;;
  esac
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    die "Node's prebuilt binaries need glibc. Install Node 22.13+ (on Alpine: apk add nodejs), then run this again."
  fi
  printf '%s-%s' "$os" "$arch"
}

main() {
  # Git Bash and friends would get a tunnel that only runs inside that shell.
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) die "on Windows, run this in PowerShell instead: irm $BASE/install.ps1 | iex" ;;
  esac
  dir="${TUNNEL_INSTALL:-$HOME/.tunnel}"
  bin="$dir/bin"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 130' INT TERM

  if command -v node >/dev/null 2>&1 && node_ok node; then
    node=node
    say "Using Node $(node --version) from $(pretty "$(command -v node)")."
  elif [ -x "$dir/node/bin/node" ] && node_ok "$dir/node/bin/node"; then
    node="$dir/node/bin/node"
    say "Using Node $("$node" --version) in $(pretty "$dir/node")."
  else
    target=$(platform)
    say "No Node 22.13+ here, so downloading Node 22 for $target..."
    fetch "$NODE_DIST/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
    file=$(grep -o "node-v[0-9.]*-$target\.tar\.gz" "$tmp/SHASUMS256.txt" | head -n 1)
    [ -n "$file" ] || die "nodejs.org has no Node 22 build for $target."
    fetch "$NODE_DIST/$file" "$tmp/$file"
    want=$(grep " $file\$" "$tmp/SHASUMS256.txt" | cut -d ' ' -f 1)
    [ "$(sha256 "$tmp/$file")" = "$want" ] || die "checksum mismatch for $file. Run this again."
    tar -xzf "$tmp/$file" -C "$tmp"
    mkdir -p "$dir"
    rm -rf "$dir/node"
    mv "$tmp/${file%.tar.gz}" "$dir/node"
    # tunnel needs only the node binary; npm, headers and docs are most of the download.
    rm -rf "$dir/node/include" "$dir/node/share" "$dir/node/lib" \
      "$dir/node/bin/npm" "$dir/node/bin/npx" "$dir/node/bin/corepack"
    node="$dir/node/bin/node"
  fi

  say "Downloading tunnel..."
  fetch "$BASE/tunnel-ai.tgz" "$tmp/tunnel-ai.tgz"
  mkdir -p "$tmp/pkg" "$dir/lib" "$bin"
  tar -xzf "$tmp/tunnel-ai.tgz" -C "$tmp/pkg"
  rm -rf "$dir/lib/tunnel-ai"
  mv "$tmp/pkg/package" "$dir/lib/tunnel-ai"

  cat >"$bin/tunnel" <<EOF
#!/bin/sh
exec "$node" "$dir/lib/tunnel-ai/dist/bin.js" "\$@"
EOF
  chmod +x "$bin/tunnel"
  version=$("$bin/tunnel" --version) || die "the installed tunnel did not start."

  on_path=0
  case ":$PATH:" in *":$bin:"*) on_path=1 ;; esac
  rc=""
  if [ "$on_path" = 0 ] && [ -z "${TUNNEL_NO_MODIFY_PATH:-}" ]; then
    line="export PATH=\"$bin:\$PATH\""
    case "${SHELL:-}" in
      */zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
      */bash) if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
      */fish)
        rc="$HOME/.config/fish/conf.d/tunnel.fish"
        line="fish_add_path \"$bin\""
        ;;
      *) rc="$HOME/.profile" ;;
    esac
    if ! grep -qsF "$bin" "$rc"; then
      mkdir -p "$(dirname "$rc")"
      printf '\n# tunnel\n%s\n' "$line" >>"$rc"
    fi
  fi

  say ""
  say "tunnel $version is installed in $(pretty "$bin")."
  if [ "$on_path" = 0 ]; then
    if [ -n "$rc" ]; then
      say "Added it to PATH in $(pretty "$rc"). Open a new terminal, or run:"
    else
      say "It is not on your PATH yet. Run:"
    fi
    say "  export PATH=\"$bin:\$PATH\""
  fi
  say ""
  say "  tunnel open              open a tunnel and get an invite code"
  say "  tunnel join <code>       join it from another machine"
  say "  tunnel skills install    teach your coding agents to use it"
}

main "$@"
