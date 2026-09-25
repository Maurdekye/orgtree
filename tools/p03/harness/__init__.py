"""P03 WS7: the contact-trace and forced-interleaving qualification harness.

The harness never decides a product rule. It checks what was OBSERVED:

- ``trace``: contact-trace records (schema ``orgtree.p03-trace/v1``) and the
  stream-health rule (no sequence gap, no drop, a clean flushed end), without
  which a run is an incomplete-contact run and cannot pass (v6
  PROFILING-AND-CONTACTS "Coverage").
- ``schedule``: a forced-interleaving schedule, its pause plan and the order it
  intends; the recorder of the order actually ACHIEVED, and the comparator. A run
  whose achieved order is not the intended one is FAILED, never passed (r7 §8.1).
- ``controls``: the unsafe-control registry. A control verdict is accepted only
  with an ``control_executed`` record for it (r7 §8.1, S3 §7).
- ``fake_executor``: an in-process executor speaking the pause-point contract, so
  the harness itself is tested (and its meta-controls fail) before the native
  executor exists. It is test scaffolding, never product evidence.
"""
