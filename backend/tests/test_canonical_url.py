import ast
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


class _DummyLogger:
    def warning(self, *args, **kwargs):
        return None


_MAIN_PATH = Path(__file__).resolve().parents[1] / "main.py"
_SOURCE = _MAIN_PATH.read_text(encoding="utf-8")
_TREE = ast.parse(_SOURCE, filename=str(_MAIN_PATH))

selected_nodes = [
    node
    for node in _TREE.body
    if isinstance(node, ast.FunctionDef) and node.name == "_canonical_url"
]

if not selected_nodes:
    raise RuntimeError("Failed to locate _canonical_url in backend/main.py")

module_ast = ast.Module(body=selected_nodes, type_ignores=[])
ast.fix_missing_locations(module_ast)
namespace = {
    "Optional": Optional,
    "urlsplit": urlsplit,
    "urlunsplit": urlunsplit,
    "parse_qsl": parse_qsl,
    "urlencode": urlencode,
    "logger": _DummyLogger(),
}
exec(compile(module_ast, str(_MAIN_PATH), "exec"), namespace)
_canonical_url = namespace["_canonical_url"]


def test_variant_query_params_stay_distinct():
    blue = _canonical_url("https://example.com/item/123?color=blue")
    red = _canonical_url("https://example.com/item/123?color=red")
    assert blue != red


def test_query_order_is_normalized():
    left = _canonical_url("https://example.com/item/123?b=2&a=1")
    right = _canonical_url("https://example.com/item/123?a=1&b=2")
    assert left == right == "https://example.com/item/123?a=1&b=2"


def test_duplicate_params_preserved():
    value = _canonical_url("https://example.com/item/123?a=2&a=1")
    assert value == "https://example.com/item/123?a=1&a=2"
    assert parse_qsl(urlsplit(value).query, keep_blank_values=True) == [("a", "1"), ("a", "2")]


def test_blank_values_preserved():
    value = _canonical_url("https://example.com/item/123?color=&size=m")
    assert value == "https://example.com/item/123?color=&size=m"
    assert parse_qsl(urlsplit(value).query, keep_blank_values=True) == [("color", ""), ("size", "m")]


def test_fragment_removed_query_kept():
    value = _canonical_url("https://example.com/item/123?a=1#reviews")
    assert value == "https://example.com/item/123?a=1"
