# EPIC activity sound and heat (4.4.0)

User rulings 2026-10-17 09:18–09:41Z add continuous sound, audible activity
counts, a physical heat field, deterministic tool-name signatures, and a
working-factory direction: machinery, moving parts and material impacts.

`activity.ts` reads the existing live tree's `busy`, `activity.phase`,
`mcp_readiness_waiting`, and `phase`. Mid-turn live agents feed one shared hum;
thinking, response writing, tool argument writing, tool execution, waiting,
and compaction each have a distinct shared machinery layer. A transformer/motor
bed underlies geared whirring, conveyor chatter, ratchets, piston strokes,
idling flywheels and grinding. Filtered friction noise and amplitude-modulated
carriers provide mechanical texture. Project nodes,
idle status reports, archived, frozen and halted agents contribute none.
The seven layer gains rise fourfold from one to fifteen agents, then cap.
Oscillators are shared rather than allocated per agent. Transitions and final
context shutdown use 300 ms gain ramps. The layers enter the existing dry
bus, limiter and master volume, below discrete event sounds. No new audio
provider read, engine field, frame loop or asset is needed for sound.

## Tray mute

User 2026-10-17 11:06Z adds a checkable **Mute EPIC sounds** tray-menu item,
visible only while EPIC is enabled. The optional boolean native preference
`epicMuted` defaults to audible and persists in the same settings file as
`epicMode`. The existing preference write broadcasts it to every window and
pop-out; no new IPC channel, subscription or settings control is added.
An open native menu updates the same item's visibility and checkmark in place.

The audio master gain after the dry/reverb paths and limiter ramps over
300 ms to zero or the existing 0.85 level. Startup applies saved mute before
greetings or activity sources. Source scheduling continues, so heat, motion,
event detection and the show's identity remain unchanged; unmute returns to
the current activity rather than replaying missed actions. Pending director
imports use the latest mute reading. Disabled EPIC still loads no director
or audio and retains only its existing preference subscription.

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

Virtualized cards retain heat sources through a borrowed reference to the
canvas's existing layout map. Mounted cards refine those positions to their
actual displayed centers. The CPU grid is at most 96×96 with cells at least about 32 world px. Steps
split at 0.25 s, with up to 24 Jacobi iterations and a `1e-6` residual-change
threshold; steady fields use up to 256 iterations. After gaps over 60 s the
remaining homogeneous transient is bounded by `exp(-0.35*60)`, so the steady
continuous-source field replaces replay of hidden frames. The simulation
assumes the most recently received source state over the elapsed interval.

`heatmap.ts` mounts one low-resolution canvas as the first child of `.space`,
under the existing node cards. World positions come from their existing
translation styles without per-node DOM or per-node layout measurements.
Pan and zoom are inherited from the same parent, so they never relocate heat
within the grid. The complete borrowed layout and card sizes define the grid
domain, including virtualized edge cards; mounting/unmounting cards while
panning, zooming or animating the camera cannot resize or resample it. DOM
bounds are a fallback only for cards absent from that layout. This uses the
existing 15 Hz layout pass, with no camera listener or extra frame loop.
Actual world-layout domain changes resample the existing field at fixed world
positions. One offscreen colour upload and one blit paint each 15 Hz frame,
with a warm ramp at 22% layer opacity. With reduced motion the steady baseline
field is shown statically and transient impulses are ignored. Stop removes
the canvas, observer, timer and media-query listener.

## Tool signatures

`toolvoice.ts` normalises case and harness/MCP prefixes, then uses FNV-1a of
the name to choose thunk, clunk, clank or stamp, material/body pitch,
inharmonic resonance, interval, waveform, envelope and low-pass colour.
There is no mapping from tool categories to sounds: every name is hashed.
Tool sounds and most event sounds use material impacts; alarms remain mechanical
buzzers. Five selected event phrases retain their original musical voicing as
described below. No random tool signature remains. The same
normalised tool sounds the same across harnesses; the existing burst pitch
climb still transposes it with activity. Tool-call sounds feed the same heat
impulse path as other agent action sounds.

## Classic event sounds

User feedback at 21:25Z on 2026-10-17 keeps some fun, game-like 4.3.x event
sounds alongside the factory palette. These five recipes and their synthesis
helpers come from 4.3.2 (`d6e8540`), with the original notes, timing and voice
lifetimes. Existing event routing, pitch and gain modifiers still apply.

| Original sound | Retained phrase | Events |
| --- | --- | --- |
| `hire` | Rising brass fanfare, drums and cymbal crash | Hire and rehire |
| `victory` | Four-note victory fanfare | Docket item completed; killswitch turned off |
| `turnEnd` | Two FM bell chimes | Completed agent turn |
| `answer` | Eleven-note pentatonic harp run | Answered question |
| `coins` | Whoosh and sparkling coin reward | Credit change, credit request, cost effect and usage reset |

The continuous machinery layers, deterministic tool impacts, other factory
event sounds and their heat impulses remain. Every recipe uses the existing
master bus, limiter, voice caps and tray-mute fade. Cards remain still.

## Factory motion

User feedback at 19:33Z on 2026-10-17 removes the working-card piston bump,
replacing the coordinator's 09:42Z approval. Working cards stay still: the heat
layer creates no card animations or CSS `translate` changes. Existing SVG/GL wire geometry is
borrowed at its existing commit point; tool and message events send short
directional transport pulses along those actual curves. At most 24 pulses
share an SVG dot pool and the heatmap's 15 Hz timer; there is no per-agent
DOM overlay or new frame loop. Reduced motion disables wire pulses. Heat and
sound retain their existing behavior.

## Verification

Focused suites: `epicmode-activity`, `epicmode-heat`, plus existing EPIC audio,
off-contract, director, progression and usage neighbours. Numerical tests cover
diffusion, symmetry, accumulation, cooling, stable bounded values and cadence;
audio tests cover gain scaling, shared resources, crossfades and cleanup.
`epicmode-gamey` checks the five retained pitch schedules and voice lifetimes;
each control fails against the factory-only recipes before restoration.
