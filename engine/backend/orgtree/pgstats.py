"""Initialize planner statistics before an imported/upgraded org is served."""


def analyze(raw, org_id: int, *, force: bool = False) -> int:
    """The restricted database function owns locking and completion tracking.

    Import calls with force=True inside its COPY/receipt transaction. A failed
    import therefore cannot leave a completion marker for unpublished data.
    """
    return int(raw.execute('SELECT public.orgtree_analyze_org(%s,%s)',
                           (int(org_id), force)).fetchone()[0])


def bootstrap(raw) -> None:
    """Called after all Python post-migration refreshes, before readiness."""
    for (org_id,) in raw.execute(
            'SELECT org_id FROM public.orgs WHERE deleted_at IS NULL ORDER BY org_id').fetchall():
        with raw.transaction():
            analyze(raw, org_id)
