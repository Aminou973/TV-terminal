"""Run OpenScript (the web app's script engine) on the server for script alerts.

The engine is bundled from web/src/scripts/engine.ts into openscript.js
(`npm run build:engine`) and executed in QuickJS — a separate, embedded JS
runtime with no file/network access — with time and memory limits.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from app.models import Bar

BUNDLE = Path(__file__).with_name("openscript.js")
TIME_LIMIT_S = 3
MEMORY_LIMIT = 128 * 1024 * 1024


@lru_cache(maxsize=1)
def _bundle() -> str:
    return BUNDLE.read_text(encoding="utf-8")


class ScriptError(RuntimeError):
    pass


def run_script(source: str, bars: list[Bar], inputs: dict | None = None, point_value: float = 1.0) -> dict:
    """Returns {kind, name, alerts:[{title,message,last,prev}], fills:[{time,action,id,price,qty,kind,reason}]}."""
    import quickjs

    ctx = quickjs.Context()
    ctx.set_time_limit(TIME_LIMIT_S)
    ctx.set_memory_limit(MEMORY_LIMIT)
    try:
        ctx.eval(_bundle())
        ctx.set(
            "ARGS",
            json.dumps(
                {
                    "src": source,
                    "bars": [b.to_dict() for b in bars],
                    "inputs": inputs or {},
                    "pv": point_value,
                }
            ),
        )
        out = ctx.eval(
            "JSON.stringify((function (a) { a = JSON.parse(a);"
            " var r = OpenScript.runScript(a.src, a.bars, a.inputs, { pointValue: a.pv });"
            " return { kind: r.kind, name: r.name, alerts: r.alerts,"
            "          fills: r.strategy ? r.strategy.fills : [] }; })(ARGS))"
        )
    except quickjs.JSException as e:
        raise ScriptError(str(e)) from e
    return json.loads(out)
