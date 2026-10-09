// electron-builder configuration for the unsigned macOS build (CI only).
// Derived from package.json's `build` so the Windows release path stays
// untouched: same app id, product name and app files; only the Rust engine,
// the mail hub, PostgreSQL, the UI and PNG runtime icons as extra resources;
// no Windows/NSIS settings and no publishing (no auto-update feed on macOS
// until the app is signed).
const base = require('../../../package.json').build

module.exports = {
  appId: base.appId,
  productName: base.productName,
  directories: { output: 'release' },
  files: base.files,
  icon: 'apps/desktop/assets/orgtree-eye-1024.png',
  extraResources: [
    { from: 'engine/rs/target/release/orgtree-engine', to: 'engine/orgtree-engine' },
    { from: 'engine/mailhub/target/release/orgtree-mailhub', to: 'engine/orgtree-mailhub' },
    { from: 'engine/postgresql', to: 'engine/postgresql' },
    { from: 'dist/renderer', to: 'ui' },
    { from: 'dist/build-info.json', to: 'build-info.json' },
    { from: '.ci-macos/runtime-icons', to: 'runtime-icons' },
  ],
  mac: {
    target: ['dir'],
    category: 'public.app-category.developer-tools',
    // Unsigned: the workflow ad-hoc signs the finished bundle itself.
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    artifactName: 'Orgtree-${version}-${arch}.${ext}',
  },
  dmg: { writeUpdateInfo: false },
  publish: null,
}
