// Retired: filesystem build locks and their queue are no longer a permit.
// Previous protocol controls remain in git history. This entry point performs
// no file/process operations; use the focused mock-build controls instead.
console.error('Retired proof: run node --test tools/rig/tests/build-permit.test.mjs; heavy work needs the caller-managed build-slot permit.')
process.exitCode = 2
