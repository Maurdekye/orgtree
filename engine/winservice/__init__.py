"""Windows service core for the boot-time engine (stdlib + ctypes only).

The packaged runtime ships no pywin32, so the SCM calls here are ctypes
bindings. This package is identity-free: it speaks the Service Control
Manager protocol and decides when the boot host starts, restarts and stops.
How the host process is created, and under which account, is the business
of the ``spawn`` callable handed to ``lifecycle.supervise``; that part is not
built yet and is reviewed separately.

Layout:
  scm.py        dispatcher, control handler and status reporting
  lifecycle.py  restart ladder, crash budget, restart control, orderly stop
"""

from __future__ import annotations

SERVICE_NAME = "OrgtreeEngine"

# User-defined control (128-255 are reserved for services). The desktop may
# send it to restart the engine without holding the service's STOP right.
CONTROL_RESTART_ENGINE = 128

# Service-specific exit codes (reported with ERROR_SERVICE_SPECIFIC_ERROR).
EXIT_SPAWN = 2         # the host could not be started, or its tree not released
EXIT_CRASH_BUDGET = 3  # the host failed too often in the window
