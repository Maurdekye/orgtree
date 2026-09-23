"""Service-side executable and custody boundary for user-token turns.

Only the Google subscription CLI is known to require the genuine Windows
session in this release. The service does not accept an arbitrary executable
or an API-key route merely because the engine asked for a bridge spawn.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Mapping


def allows_google_subscription(profile: Path, argv: list[str], cwd: str,
                               env: Mapping[str, str]) -> bool:
    if os.name != "nt" or len(argv) < 10 or not isinstance(cwd, str):
        return False
    expected = profile / "AppData" / "Local" / "agy" / "bin" / "agy.exe"
    try:
        if (not expected.is_file() or expected.is_symlink()
                or Path(argv[0]).resolve(strict=True) != expected.resolve(strict=True)):
            return False
    except (OSError, ValueError):
        return False
    if argv[1:7] != ["-p=", "--input-format", "stream-json",
                     "--output-format", "stream-json", "--add-dir"]:
        return False
    if argv[7] != cwd or argv[8] != "--model" or not argv[9]:
        return False
    # A Google key account is file-backed and belongs to the service-safe
    # path. Bridging it would widen custody to the interactive user for no
    # reason. The CLI's subscription login uses its Windows keyring instead.
    upper = {str(key).upper(): str(value) for key, value in env.items()}
    if any(upper.get(key) for key in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "AGY_ADC_AUTH")):
        return False
    if upper.get("AGY_CLI_DISABLE_AUTO_UPDATE") != "true":
        return False
    allowed_flags = {"--effort", "--conversation", "--log-file", "--print-timeout"}
    index = 10
    while index < len(argv):
        flag = argv[index]
        if flag == "--dangerously-skip-permissions":
            index += 1
            continue
        if flag not in allowed_flags or index + 1 >= len(argv) or not argv[index + 1]:
            return False
        index += 2
    return True
