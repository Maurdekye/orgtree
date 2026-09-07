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
    return dict(version=1, enabled=enabled, bind_host=bind, port=port, advertise_host=advertise)


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
            advertise_host=config['advertise_host'] if config['enabled'] else '127.0.0.1')
        ready = service.start()
        self.service, self.ready = service, ready
        # Owner transport ALWAYS stays loopback, even when advertised publicly.
        os.environ['ORGTREE_V2_HUB_ADDRESS'] = f'http://127.0.0.1:{ready.port}'
        os.environ['ORGTREE_V2_HUB_TOKEN'] = ready.token
        os.environ['ORGTREE_V2_HUB_ADVERTISED'] = f'http://{ready.host}:{ready.port}'

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
            return {**self.config, 'status':{
                'ready':self.ready is not None,
                'port':self.ready.port if self.ready else None,
                'address':f'http://{self.ready.host}:{self.ready.port}' if self.ready else None,
                'public':bool(self.ready and self.config['enabled'] and self.config['bind_host'] == '0.0.0.0')},
                'warning':'Public HTTP hosting requires external TLS or trusted network protection.'}

    def configure(self, raw):
        config = validate_config(raw)
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
