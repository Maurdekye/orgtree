// frontend/tests/testguard/idle.worker.mjs - testguard.test.tsx §11b's worker,
// started from a file the way a test might start one. NOT a test file (run.mjs
// never bundles it). It only idles; the preloaded guard loads in it.
setTimeout(() => {}, 300)
