"""Engine boundary tests.

Importing this package asserts import provenance before any test module gets a
chance to import the engine.  That covers every invocation that imports `tests`
as a package — `python -m unittest tests.test_x`, `-m unittest discover`,
pytest — for all modules at once.

It does NOT cover `python tests/test_x.py`, nor the sanctioned runner, which
uses `runpy.run_path` and never imports this package.  Those two put
`<checkout>/tests` on `sys.path[0]` instead, which is why each test module
carries its own flat `import import_provenance` line.  Publishing the alias
below makes that same flat line resolve here in package mode too, so all 178
modules carry one identical line rather than a mode-dependent one.
"""

import sys

from . import import_provenance

sys.modules.setdefault("import_provenance", import_provenance)
