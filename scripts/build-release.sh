#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
name=diobot
package="dist/package/$name-linux-x86_64"
rm -rf -- "$package"
mkdir -p "$package"
deno task compile
install -m 0755 dist/diobot "$package/diobot"
printf '%s\n' "$(git rev-parse HEAD)" > "$package/SOURCE_COMMIT"
# Only explicitly selected release files are archived; never include the worktree.
archive="$name-linux-x86_64.tar.gz"
tar -C dist/package -czf "dist/$archive" "$name-linux-x86_64"
(cd dist && sha256sum "$archive" > SHA256SUMS)
