#!/usr/bin/env bash
# build-info-standalone.json: what the standalone assets are and that the image is the
# archive's binary. The image's identity is its config digest, which `docker load`, a
# GHCR push and a GHCR pull all keep (a registry's manifest digest depends on how the
# layers were compressed for that push; publish-standalone-image.yml records it).
# Usage: build-info.sh <dist dir> <version> <commit> <image repository> <prerelease true|false> <extracted engine binary>
set -euo pipefail
dist=$1 version=$2 commit=$3 repo=$4 prerelease=$5 engine=$6
bin="orgtree-engine-standalone-$version-linux-x86_64.tar.gz"
img="orgtree-engine-standalone-$version-docker-amd64.tar.gz"
sha() { sha256sum "$1" | cut -d' ' -f1; }
# docker save writes manifest.json with Config "blobs/sha256/<hex>" (OCI layout) or "<hex>.json".
config=$(tar -xzOf "$dist/$img" manifest.json | jq -r '.[0].Config' | sed -E 's#^blobs/sha256/##; s#\.json$##')
[[ "$config" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::no config digest in $img ($config)"; exit 1; }
tags=$(if [ "$prerelease" = true ]; then jq -nc --arg v "$version" '[$v]'; else jq -nc --arg v "$version" '[$v, "latest"]'; fi)
jq -n --arg version "$version" --arg commit "$commit" --arg bin "$bin" --arg binsha "$(sha "$dist/$bin")" \
  --arg engine "$(sha "$engine")" --arg img "$img" --arg imgsha "$(sha "$dist/$img")" --arg repo "$repo" \
  --arg config "sha256:$config" --argjson tags "$tags" '{
    version: $version, commit: $commit,
    binary: {file: $bin, sha256: $binsha, engine_sha256: $engine, platform: "linux/x86_64"},
    image: {file: $img, sha256: $imgsha, repository: $repo, tags: $tags, config_digest: $config, platform: "linux/amd64",
            engine_sha256: $engine}
  }' > "$dist/build-info-standalone.json"
cat "$dist/build-info-standalone.json"
