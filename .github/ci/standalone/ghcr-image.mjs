// The config digest of a GHCR image tag, read from the registry API (no Docker needed).
// The config digest is the image's identity: the same after `docker load`, a push and a
// pull, so it proves the GHCR image is the release's image archive.
//   ghcrImage({ image: 'ghcr.io/owner/name', tag, token }) -> { config, manifest } digests, or null (no such tag)
// `token` is a GitHub token with packages:read (GITHUB_TOKEN); without one only a public
// package can be read.
import { pathToFileURL } from 'node:url'

export async function ghcrImage({ image, tag, token }) {
  const [, host, name] = /^([^/]+)\/(.+)$/.exec(image) ?? []
  if (host !== 'ghcr.io') throw new Error(`not a ghcr.io image: ${image}`)
  const auth = token ? { Authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}` } : {}
  const tokenResponse = await fetch(`https://ghcr.io/token?scope=repository:${name}:pull&service=ghcr.io`, { headers: auth })
  if (!tokenResponse.ok) throw new Error(`ghcr.io token for ${name}: HTTP ${tokenResponse.status}`)
  const bearer = (await tokenResponse.json()).token
  const accept = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ')
  const manifest = async ref => {
    const response = await fetch(`https://ghcr.io/v2/${name}/manifests/${ref}`, { headers: { Authorization: `Bearer ${bearer}`, Accept: accept } })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`${image}:${ref}: HTTP ${response.status}`)
    return { digest: response.headers.get('docker-content-digest'), body: await response.json() }
  }
  let found = await manifest(tag)
  if (!found) return null
  if (found.body.manifests) { // an index: the linux/amd64 image in it
    const amd64 = found.body.manifests.find(m => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64')
    if (!amd64) throw new Error(`${image}:${tag} has no linux/amd64 image`)
    found = await manifest(amd64.digest)
  }
  return { config: found.body.config?.digest ?? null, manifest: found.digest }
}

// CLI: node ghcr-image.mjs <image> <tag> -> prints {"config":..., "manifest":...} or null
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [image, tag] = process.argv.slice(2)
  console.log(JSON.stringify(await ghcrImage({ image, tag, token: process.env.GH_TOKEN })))
}
