# EPIC activity sound and heat (4.4.0)

User rulings 2026-10-17 09:18–09:25Z add continuous sound, audible activity
counts, a physical heat field, and deterministic tool-name signatures.

`activity.ts` reads the existing live tree's `busy`, `activity.phase`,
`mcp_readiness_waiting`, and `phase`. Mid-turn live agents feed one shared hum;
thinking, response writing, tool argument writing, tool execution, waiting,
and compaction each have a distinct shared oscillator layer. Project nodes,
idle status reports, archived, frozen and halted agents contribute none.
The seven layer gains rise fourfold from one to fifteen agents, then cap.
Oscillators are shared rather than allocated per agent. Transitions and final
context shutdown use 300 ms gain ramps. The layers enter the existing dry
bus, limiter and master volume, below discrete event sounds. No new audio
preference, provider read, engine field, frame loop or asset is needed for sound.

Enabling during existing work seeds from a borrowed reference to the App's
already published tree. While EPIC is off this is only a reference assignment
at the existing publish sites: no copied snapshot, listener, DOM or audio.
Org removal and socket loss silence the layers; stop closes them after fading.

## Heat equation

`heatfield.ts` solves the backward-Euler discretisation of
`dT/dt = D * laplacian(T) - loss*T + Q`, using Jacobi ping-pong iteration,
no-flux boundaries, `D = 1800 world-px²/s`, and ambient loss `0.35/s`.
Continuous sources inject a fixed `0.30 temperature/s` per active agent with
an activity layer (`0.18/s` for the hum alone). Each accepted action sound at
an agent injects an instantaneous `0.18` delta. Nearby heat adds through the
diffusion equation; temperatures cap at 1. More work and more actions therefore
build heat, which spreads and cools after sources stop.

The CPU grid is at most 96×96 with cells at least about 32 world px. Steps
split at 0.25 s, with up to 24 Jacobi iterations and a `1e-6` residual-change
threshold; steady fields use up to 256 iterations. After gaps over 60 s the
remaining homogeneous transient is bounded by `exp(-0.35*60)`, so the steady
continuous-source field replaces replay of hidden frames. The simulation
assumes the most recently received source state over the elapsed interval.

`heatmap.ts` mounts one low-resolution canvas as the first child of `.space`,
under the existing node cards. World positions come from their existing
translation styles without per-node DOM or per-node layout measurements.
Pan and zoom are inherited from the same parent, so they never relocate heat
within the grid. Domain changes resample the existing field at fixed world
positions. One offscreen colour upload and one blit paint each 15 Hz frame,
with a warm ramp at 22% layer opacity. With reduced motion the steady baseline
field is shown statically and transient impulses are ignored. Stop removes
the canvas, observer, timer and media-query listener.

## Tool signatures

`toolvoice.ts` normalises case and harness/MCP prefixes, then uses FNV-1a of
the name to choose a pentatonic pitch, consonant interval, waveform, envelope
and low-pass colour. No family table or random signature remains. The same
normalised tool sounds the same across harnesses; the existing burst pitch
climb still transposes it with activity. Tool-call sounds feed the same heat
impulse path as other agent action sounds.

## Verification

Focused suites: `epicmode-activity`, `epicmode-heat`, plus existing EPIC audio,
off-contract, director, progression and usage neighbours. Numerical tests cover
diffusion, symmetry, accumulation, cooling, stable bounded values and cadence;
audio tests cover gain scaling, shared resources, crossfades and cleanup.
