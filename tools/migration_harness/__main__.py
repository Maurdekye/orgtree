"""Run only freshly generated synthetic data; emit one structured JSON report."""
import argparse
import json
import tempfile
from pathlib import Path

from .fixtures import SCENARIOS, create_fixture
from .harness import HARNESS_VERSION, Rehearsal
from .legacy import Refused, digest, encode, manifest, plain_tree


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=SCENARIOS, default="ordinary")
    args = parser.parse_args(argv)
    report = {"format": "orgtree-synthetic-migration-report", "version": HARNESS_VERSION,
              "scenario": args.scenario, "synthetic": True,
              "not_exercised": ["native_schema_import", "live_source_capture", "activation_writer_fences",
                                "post_activation_current_state_rollback", "power_loss_durability",
                                "streaming_memory_bounds", "external_effect_reconciliation"],
              "mapping_status": "preserved_unmapped", "activation_allowed": False}
    try:
        with tempfile.TemporaryDirectory(prefix="orgtree-synthetic-migration-") as directory:
            root = Path(directory)
            create_fixture(root, args.scenario)
            source = manifest(plain_tree(root / "source"))
            harness = Rehearsal(root)
            interrupted = False
            if args.scenario == "interrupted":
                class SimulatedInterruption(RuntimeError):
                    pass
                def checkpoint(event):
                    if event == "published":
                        raise SimulatedInterruption()
                try:
                    Rehearsal(root, checkpoint=checkpoint).migrate()
                except SimulatedInterruption:
                    interrupted = True
                if not interrupted:
                    raise Refused("interruption control did not fire")
            receipt = harness.migrate()
            first = (root / "receipt.json").read_bytes()
            if harness.migrate() != receipt or (root / "receipt.json").read_bytes() != first:
                raise Refused("retry changed receipt")
            restored = harness.rollback()
            if manifest(plain_tree(root / "source")) != source or restored["restored_manifest"] != source:
                raise Refused("source/restore conservation failed")
            report.update(result="passed", classification="met", checks={
                "backup_verified": True, "source_unchanged": True, "candidate_conservation": True,
                "retry_same_receipt": True, "rollback_byte_equal": True, "rollback_readable": True},
                fault="python_exception_after_publish" if interrupted else "none",
                receipt=receipt, rollback_receipt=restored,
                inventory=receipt["plan"]["inventory"], receipt_sha256=digest(first),
                source_manifest_sha256=digest(encode(source)))
    except (Refused, OSError) as exc:
        report.update(result="refused", classification=("known_negative" if args.scenario == "malformed" and isinstance(exc, Refused)
                      else "environment_limited" if isinstance(exc, OSError) else "not_exercised"), reason=str(exc))
        print(json.dumps(report, sort_keys=True))
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
