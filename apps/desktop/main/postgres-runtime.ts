/** A bundled executable's file name on this platform (`.exe` only on Windows). */
export function exeName(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}

/** Installed apps always use bundled paths and may bootstrap a fresh root.
 * A developer's path opt-in alone must never enable first-run initialization. */
export function postgresLaunchOptions(packaged: boolean, env: NodeJS.ProcessEnv) {
  return { packagedPostgres: packaged || env.ORGTREE_DESKTOP_PACKAGED_PG === '1', bootstrapPostgres: packaged }
}

// 4.6.1: writeEnginePaths (the Python engine's engine-paths.json) and
// postgresRuntimeEnvironment (pg-custodian.exe + bin for the Python launch) are
// gone with the Python engine. The Rust engine finds PostgreSQL beside itself;
// engine.ts passes ORGTREE_P03_PG_BIN.
