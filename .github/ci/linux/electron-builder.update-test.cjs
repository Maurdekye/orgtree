// electron-builder config for update-test.sh's two AppImages, N and N+1: the release
// Linux config (electron-builder.linux.cjs) with three differences, all test-only.
// - The version is the test's (UPDATE_TEST_VERSION), with a build-info.json to match
//   (UPDATE_TEST_BUILD_INFO), so N and N+1 come from one commit and one engine build.
// - The packaged feed (app-update.yml) is a generic loopback URL (UPDATE_TEST_FEED)
//   instead of GitHub, with single-range requests like the GitHub provider. Nothing at
//   run time is overridden: the app reads its packaged feed exactly as a real install.
// - AppImage only, into the test's own folder (UPDATE_TEST_OUT), never into release/:
//   nothing built here is staged.
const linux = require('./electron-builder.linux.cjs')

const env = name => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (see .github/ci/linux/update-test.sh)`)
  return value
}
const feed = env('UPDATE_TEST_FEED')
if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(feed)) throw new Error(`UPDATE_TEST_FEED must be http://127.0.0.1:<port>/, not ${feed}`)
const buildInfo = env('UPDATE_TEST_BUILD_INFO')
if (!linux.extraResources.some(resource => resource.to === 'build-info.json')) throw new Error('the Linux config no longer packages build-info.json')

module.exports = {
  ...linux,
  extraMetadata: { ...linux.extraMetadata, version: env('UPDATE_TEST_VERSION') },
  directories: { ...linux.directories, output: env('UPDATE_TEST_OUT') },
  extraResources: linux.extraResources.map(resource => resource.to === 'build-info.json' ? { ...resource, from: buildInfo } : resource),
  linux: { ...linux.linux, target: ['AppImage'] },
  publish: [{ provider: 'generic', url: feed, useMultipleRangeRequest: false }],
}
