#!/usr/bin/env bash
set -euo pipefail

server_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$server_dir/.." && pwd)"
build_dir="$repo/cdk/.build/lambda"
lambda_binary="$server_dir/target/lambda/frc-packs-server/bootstrap"

if ! command -v cargo-lambda >/dev/null 2>&1; then
  echo "Install cargo-lambda first: cargo install cargo-lambda" >&2
  exit 1
fi

(cd "$server_dir" && cargo lambda build --release --features lambda --arm64)

test -x "$lambda_binary" || {
  echo "cargo-lambda did not produce the expected executable: $lambda_binary" >&2
  exit 1
}

rm -rf "$build_dir"
mkdir -p "$build_dir/data"
cp "$lambda_binary" "$build_dir/bootstrap"
cp -a "$repo/data/packs" "$build_dir/data/packs"
# The server reads these at startup (Battler cards); without them every request fails.
cp -a "$repo/data/battler" "$build_dir/data/battler"
test -f "$build_dir/data/battler/support-2026.json" || { echo "missing Battler data in the Lambda bundle" >&2; exit 1; }
chmod 755 "$build_dir/bootstrap"

echo "Built Lambda assets in $build_dir"
