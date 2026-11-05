# App-panel resize: pointer-trace diagnostic driver (harness only)

`capture-r3-pointer-trace.cjs` is @rig-sol-b's sealed `capture-r3.cjs` (sha256 adb22b53f6e916550b78b0f126554cc8938324bf7b56e36f918eada26830fb77, as copied by @build-sol) with FOUR harness-only edits. No product change.

1. `TRACE_JS` is injected into the page right after the App entry mounts: a capture-phase window listener for pointerdown/move/up/cancel, gotpointercapture/lostpointercapture and mousedown/move/up. Each record: type, target tag, target class, `data-resize-edge`, pointerId, buttons, clientX/Y, whether ANY resize handle hasPointerCapture(pointerId), page-clock ms.
2. Every driver `Input.dispatchMouseEvent` is preceded by a `{src:'driver',what,x,y,t}` marker in the same array, so each CDP step lines up with what the page saw.
3. The edge order is east first: `['e','n','s','w','ne','nw','se','sw']`.
4. On any outcome (pass or the failure path) the array is written to `<out>/pointer-trace.json` and `result.trace`.

Run it exactly as the R3 driver (same config, same guard-normal.cjs beside it); tip arm only is enough. Decision rule (coordinator-opus 2026-11-05 18:44Z): if the page never records a move/up once the pointer crosses the iframe, it is harness/OOPIF input; if it does and the handle still does not save, it is a product bug.
