"""MVP exclusions are enforced at API admission and execution, not just UI."""
import os


def enabled():
    return os.environ.get('ORGTREE_DESKTOP_MANAGED') == '1'


def install_routes(app):
    app.router.routes[:] = [route for route in app.router.routes
        if not (str(getattr(route,'path','')).startswith(('/api/accounts/keys','/api/accounts/order'))
                or '/git/' in str(getattr(route,'path','')))]
