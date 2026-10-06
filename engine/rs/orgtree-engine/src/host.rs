//! `orgtree-engine host`: the boot-time supervisor the "Orgtree Background
//! Engine" scheduled task runs. It starts the engine, publishes the attach
//! descriptor, watches liveness and restarts a hung engine.

use std::process::ExitCode;

#[logged]
pub fn run() -> ExitCode {
    eprintln!("orgtree-engine host: not available in this build yet");
    ExitCode::from(1)
}
