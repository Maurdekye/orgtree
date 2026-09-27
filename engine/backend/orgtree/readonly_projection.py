"""A partial read model must never become durable whole-org state."""

class ProjectionDoc(dict):
    """Carries its prohibition through Org wrapping and deepcopy."""
    _read_only_projection = True


def reject_projection(value):
    if getattr(value, '_read_only_projection', False) or getattr(
            getattr(value, 'd', None), '_read_only_projection', False):
        raise TypeError('partial read-only projection cannot be persisted or wrapped as Org')
