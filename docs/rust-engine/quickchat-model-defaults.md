# Quick chat superior identity and model defaults

User decisions: 2026-10-18 17:13Z and 17:15Z.

The selected “top level” superior and its option row use `SwitchboardMark`
from the Agents-list module. The final list styling makes the mark 16 px;
the selected control matches that size, colour and 8 px label gap. Agent and
project superior identity cards keep their existing rendering.

With no usable saved choice, model preference is Opus, Sol, Argon, Wonder,
then the first hireable tier. Quick chat reads the existing shared staffing
availability instead of treating provider presence as eligibility. Managed
account rows already exclude disabled, signed-out and model-exhausted accounts.
The additive `native_ok` field applies the existing `usage::at_limit` model
window check to the native login; existing `default_ok` semantics are unchanged.
When a named eligible account makes the choice runnable, the hire carries that
account. A configured eligible org default wins over other named alternatives.

Credit checks mirror the user hire cascade: projects pass costs upward,
`cascade_hire: false` requires the paying parent's free credits, and the
top-level grant cap still applies. They do not disable all models merely
because a parent can draw credits through its normal cascade.

Saved-choice precedence remains per-org manual choice, template defaults,
then the last manual model/effort elsewhere. Eligibility is applied afterward.
An unavailable remembered model remains stored and returns when usable again;
a fallback is not written merely by rendering it. An actual successful hire
still remembers the model hired. Automatic model fallbacks inherit the default
effort, while a supported remembered/manual model retains its effort choice.

## Focused evidence

- Initial eye/order control: three intended semantic failures, no skips or
  cancellations. Separate frozen account/credit control: three intended
  semantic failures, no skips or cancellations. Both child exits were 1.
- The focused Quick chat suite passed 28/28, no skips or cancellations, child
  exit 0. An older row-depth assertion counted identity-marked buttons as
  rows; a frozen-source control reproduced that failure before it was narrowed.
- The synthetic 1000×700 Electron capture reports equal 16×16 marks, 8 px gaps,
  colour and markup; its PNG was inspected. The first capture exposed an
  18-versus-16 size mismatch and is retained as failed evidence.

This is synthetic renderer evidence, not live provider eligibility or native
mouse-input proof. Phase 1 omits broad suites and simulated-org proofs.
