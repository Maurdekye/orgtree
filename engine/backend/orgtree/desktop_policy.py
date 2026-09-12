"""MVP exclusions are enforced at API admission and execution, not just UI."""
import os


def enabled():
    return os.environ.get('ORGTREE_DESKTOP_MANAGED') == '1'


def validate(values):
    if not enabled():
        return
    forbidden = [key for key in ('kiosk','sandbox') if values.get(key)]
    if values.get('disk_mb') is not None:
        forbidden.append('disk_mb')
    if forbidden:
        raise ValueError('Not available in desktop MVP: ' + ', '.join(forbidden))


def install_routes(app):
    app.router.routes[:] = [route for route in app.router.routes
        if not (str(getattr(route,'path','')).startswith(('/api/accounts/keys','/api/accounts/order'))
                or '/kiosk' in str(getattr(route,'path',''))
                or '/git/' in str(getattr(route,'path','')))]
