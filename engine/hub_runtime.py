"""Persisted, explicitly enabled mailhub hosting for the desktop engine."""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
import threading
from engine.hub import HubService


def validate_config(raw):
    if not isinstance(raw, dict) or raw.get('version', 1) != 1:
        raise ValueError('unsupported hub configuration')
    enabled = raw.get('enabled', False)
    port = raw.get('port', 0)
    bind = raw.get('bind_host', '127.0.0.1')
    advertise = str(raw.get('advertise_host', '127.0.0.1')).strip()
    if type(enabled) is not bool or type(port) is not int or not 0 <= port <= 65535:
        raise ValueError('enabled must be boolean and port must be 0..65535')
    if bind not in {'127.0.0.1', '0.0.0.0'}:
        raise ValueError('bind_host must be 127.0.0.1 or 0.0.0.0')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}', advertise):
        raise ValueError('advertise_host must be a hostname or IPv4 address, without a scheme or port')
    if enabled and advertise == '0.0.0.0':
        raise ValueError('advertise_host must name a reachable host, not 0.0.0.0')
    config = dict(version=1, enabled=enabled, bind_host=bind, port=port, advertise_host=advertise)
    for field in ('tls_certfile','tls_keyfile','tls_ca_file'):
        value = str(raw.get(field) or '').strip()
        if value:
            path = Path(value)
            if not path.is_absolute() or not path.is_file():
                raise ValueError(f'{field} must name an existing absolute file')
            config[field] = str(path.resolve())
    if enabled and bind == '0.0.0.0' and not all(config.get(k) for k in ('tls_certfile','tls_keyfile')):
        raise ValueError('public hosting requires a TLS certificate and private key')
    return config


class HubRuntime:
    def __init__(self, root):
        self.root = Path(root).resolve(strict=True)
        self.path = self.root / 'desktop-hub.json'
        self.config = validate_config(json.loads(self.path.read_text()) if self.path.exists() else {})
        self.service = None
        self.ready = None
        self.lock = threading.RLock()

    def _start(self, config):
        service = HubService(self.root,
            host=config['bind_host'] if config['enabled'] else '127.0.0.1',
            port=config['port'],
            advertise_host=config['advertise_host'] if config['enabled'] else '127.0.0.1',
            tls_certfile=config.get('tls_certfile'), tls_keyfile=config.get('tls_keyfile'),
            tls_ca_file=config.get('tls_ca_file'))
        ready = service.start()
        self.service, self.ready = service, ready
        # Owner transport ALWAYS stays loopback, even when advertised publicly.
        scheme = 'https' if ready.tls else 'http'
        os.environ['ORGTREE_V2_HUB_ADDRESS'] = f'{scheme}://127.0.0.1:{ready.port}'
        os.environ['ORGTREE_V2_HUB_TOKEN'] = ready.token
        os.environ['ORGTREE_V2_HUB_CA_FILE'] = str(ready.tls_ca_file or '')
        os.environ['ORGTREE_V2_HUB_ADVERTISED'] = f'{scheme}://{ready.host}:{ready.port}'

    def start(self):
        with self.lock:
            self._start(self.config)
            return self.ready

    def stop(self):
        with self.lock:
            if self.service:
                self.service.stop()
                self.service = None
                self.ready = None

    def status(self):
        with self.lock:
            visible = {k:v for k,v in self.config.items() if not k.startswith('tls_')}
            return {**visible, 'tls_configured': bool(self.config.get('tls_certfile')), 'status':{
                'ready':self.ready is not None,
                'port':self.ready.port if self.ready else None,
                'address':f'{"https" if self.ready.tls else "http"}://{self.ready.host}:{self.ready.port}' if self.ready else None,
                'public':bool(self.ready and self.config['enabled'] and self.config['bind_host'] == '0.0.0.0')},
                'warning':'Public hosting requires a manually provisioned trusted TLS certificate.'}

    def configure(self, raw):
        config = validate_config({**self.config, **raw})
        with self.lock:
            previous = self.config
            self.stop()
            try:
                self._start(config)
                # Persist the assigned port so hosting remains reachable after restart.
                config['port'] = self.ready.port
                temporary = self.path.with_suffix('.tmp')
                temporary.write_text(json.dumps(config), encoding='utf-8')
                os.replace(temporary, self.path)
                self.config = config
            except Exception:
                self.stop()
                self._start(previous)
                raise RuntimeError('hub configuration failed; previous configuration restored') from None
            return self.status()
