"""Test bootstrap: configure env BEFORE any app module is imported.

App modules read settings at import time (module singletons), so environment
must be pinned here. Tests get a fresh temp workspace per pytest session.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="openterm-test-"))
os.environ["OPENTERM_DATA_DIR"] = str(_TMP / "data")
os.environ["OPENTERM_SQLITE_PATH"] = str(_TMP / "test.db")
os.environ["OPENTERM_JWT_SECRET"] = "test-secret"
os.environ["OPENTERM_REPLAY_ENABLED"] = "true"
os.environ["OPENTERM_REPLAY_SYMBOL"] = "SIM:ES"
os.environ["OPENTERM_CCXT_ENABLED"] = "false"
os.environ["OPENTERM_NINJA_ENABLED"] = "false"
os.environ["OPENTERM_YF_ENABLED"] = "false"
