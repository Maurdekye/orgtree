#!/usr/bin/env bash
# Pushes one standalone image of a published release to GHCR (publish-standalone-image.yml):
#   publish-image.sh <tag> <build-info file name> <prerelease true|false>
# build-info-standalone.json is the plain image (tags <v>, latest);
# build-info-standalone-agents.json the agents image (tags <v>-agents, latest-agents).
# The image is the release's own asset, checked against SHA256SUMS.txt and the
# build-info file and `docker load`ed: nothing is rebuilt. Its tags are pushed
# (the latest* ones only for a stable release), read back from the registry and
# checked by config digest. A release without that asset is skipped with a notice.
# Needs GH_TOKEN (contents: read, packages: write) and GITHUB_REPOSITORY(_OWNER).
set -euo pipefail
tag=$1 info=$2 prerelease=$3
here="$(cd "$(dirname "$0")" && pwd)"
version="${tag#v}"
dl="dl-${info%.json}"
mkdir -p "$dl"
assets="$(gh release view "$tag" --repo "$GITHUB_REPOSITORY" --json assets --jq '.assets[].name')"
if ! grep -qx "$info" <<<"$assets"; then
  echo "::notice::$tag has no $info: nothing to push for it (release-standalone.yml adds it)."
  exit 0
fi
gh release download "$tag" --repo "$GITHUB_REPOSITORY" -D "$dl" -p "$info" -p SHA256SUMS.txt
img="$(jq -r .image.file "$dl/$info")"
grep -qx "$img" <<<"$assets" || { echo "::error::$info names $img, which $tag does not have"; exit 1; }
gh release download "$tag" --repo "$GITHUB_REPOSITORY" -D "$dl" -p "$img"
(cd "$dl" && grep -E "  ($(sed 's/[.]/\\./g' <<<"$img")|$(sed 's/[.]/\\./g' <<<"$info"))\$" SHA256SUMS.txt | sha256sum -c -)
[ "$(grep -cE "  ($(sed 's/[.]/\\./g' <<<"$img")|$(sed 's/[.]/\\./g' <<<"$info"))\$" "$dl/SHA256SUMS.txt")" = 2 ] \
  || { echo "::error::SHA256SUMS.txt does not list both $img and $info"; exit 1; }
[ "$(jq -r .version "$dl/$info")" = "$version" ] || { echo "::error::$info is not $version"; exit 1; }
[ "$(jq -r .image.sha256 "$dl/$info")" = "$(sha256sum "$dl/$img" | cut -d' ' -f1)" ] || { echo "::error::$img is not the one $info names"; exit 1; }
repo="$(jq -r .image.repository "$dl/$info")"
[ "$repo" = "ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/orgtree-engine" ] || { echo "::error::unexpected image repository $repo"; exit 1; }
config="$(jq -r .image.config_digest "$dl/$info")"
# the first tag is the one the image was saved with; latest* follow stable releases only
mapfile -t tags < <(jq -r '.image.tags[]' "$dl/$info")
first="${tags[0]}"
[ "$prerelease" = true ] && mapfile -t tags < <(printf '%s\n' "${tags[@]}" | grep -v '^latest')

docker load -i "$dl/$img"
echo "$GH_TOKEN" | docker login ghcr.io -u "${GITHUB_ACTOR:-github-actions}" --password-stdin
for t in "${tags[@]}"; do
  [ "$t" = "$first" ] || docker tag "$repo:$first" "$repo:$t"
  docker push "$repo:$t"
done
docker logout ghcr.io

{ echo "### $repo ($tag, $info)"; echo; echo '| tag | config digest | manifest digest |'; echo '|---|---|---|'; } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
for t in "${tags[@]}"; do
  got="$(node "$here/ghcr-image.mjs" "$repo" "$t")"
  echo "$repo:$t -> $got"
  [ "$(jq -r .config <<<"$got")" = "$config" ] || { echo "::error::$repo:$t is not the release's image ($config)"; exit 1; }
  echo "| $t | \`$(jq -r .config <<<"$got")\` | \`$(jq -r .manifest <<<"$got")\` |" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
done
