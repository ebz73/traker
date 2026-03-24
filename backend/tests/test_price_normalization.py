import ast
import re
from pathlib import Path
from typing import Optional

import pytest


_MAIN_PATH = Path(__file__).resolve().parents[1] / "main.py"
_SOURCE = _MAIN_PATH.read_text(encoding="utf-8")
_TREE = ast.parse(_SOURCE, filename=str(_MAIN_PATH))

_WANTED_ASSIGNMENTS = {
    "_FUEL_CONTEXT_PATTERN",
    "_DOT_THOUSANDS_LOCALE_PREFIXES",
}
_WANTED_FUNCTIONS = {
    "_locale_uses_dot_thousands",
    "_is_clear_thousands_grouping",
    "_is_fuel_or_measurement_context",
    "_normalize_price",
}

selected_nodes = []
for node in _TREE.body:
    if isinstance(node, ast.Assign):
        target_names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        if any(name in _WANTED_ASSIGNMENTS for name in target_names):
            selected_nodes.append(node)
    elif isinstance(node, ast.FunctionDef) and node.name in _WANTED_FUNCTIONS:
        selected_nodes.append(node)

if not selected_nodes:
    raise RuntimeError("Failed to locate normalization helpers in backend/main.py")

module_ast = ast.Module(body=selected_nodes, type_ignores=[])
ast.fix_missing_locations(module_ast)
namespace = {"re": re, "Optional": Optional}
exec(compile(module_ast, str(_MAIN_PATH), "exec"), namespace)
_normalize_price = namespace["_normalize_price"]


@pytest.mark.parametrize(
    "raw,kwargs,expected",
    [
        ("$1.999/gal", {}, 1.999),
        ("1.999 per gallon", {}, 1.999),
        ("€1.234,56", {}, 1234.56),
        ("$1,234.56", {}, 1234.56),
        ("1.234.567", {"locale_hint": "de"}, 1234567.0),
        ("1.500", {}, 1.5),
        ("1.500", {"locale_hint": "de"}, 1500.0),
    ],
)
def test_normalize_price_context_aware(raw, kwargs, expected):
    value = _normalize_price(raw, **kwargs)
    assert value == pytest.approx(expected)
