// electron-builder config for the Linux CI build (AppImage + .deb).
// Derived from package.json "build" so the Windows config stays the single source for
// shared fields; only the Windows-specific inputs (.exe binaries, NSIS, the Python 3.x
// engine and its runtime) are swapped for their Linux equivalents here.
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..', '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const base = pkg.build
const { win, nsis, publish, ...shared } = base

module.exports = {
  ...shared,
  // PNG set rendered from orgtree-eye.svg by the workflow (Linux cannot use the .ico).
  icon: 'build/linux/icons',
  extraResources: [
    // Only what the Rust engine path needs: the engine, the mail hub, the bundled
    // PostgreSQL built by .github/ci/linux/build-postgres.sh, and the renderer.
    // The Python 3.x engine, its runtime and the 3.x importer are Windows-only (no
    // Linux user has 3.x data to upgrade).
    { from: 'engine/rs/target/release/orgtree-engine', to: 'engine/orgtree-engine' },
    { from: 'engine/mailhub/target/release/orgtree-mailhub', to: 'engine/orgtree-mailhub' },
    { from: 'build/linux/postgresql', to: 'engine/postgresql' },
    { from: 'dist/renderer', to: 'ui' },
    { from: 'dist/build-info.json', to: 'build-info.json' },
    // PNG window/tray icons rendered by .github/ci/linux/icons.sh (same base names as the .ico set).
    { from: 'build/linux/runtime-icons', to: 'runtime-icons' },
  ],
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Development',
    executableName: 'orgtree',
    maintainer: 'Maurdekye <noreply@github.com>',
    artifactName: 'Orgtree-${version}.${ext}',
  },
  deb: {
    artifactName: 'orgtree_${version}_${arch}.${ext}',
    // Electron's own runtime libraries; PostgreSQL is bundled and needs only glibc + zlib.
    depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils',
      'libatspi2.0-0', 'libuuid1', 'libsecret-1-0', 'libasound2 | libasound2t64', 'zlib1g'],
  },
  appImage: { artifactName: 'Orgtree-${version}.${ext}' },
  publish: null,
}
