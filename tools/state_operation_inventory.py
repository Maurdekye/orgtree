"""Inventory backend registrations without importing or starting the backend.

This is the source-coverage part of P01, not an executed-operation census or
proof of a transitive call graph. Unresolved expressions remain visible. The
complete backend source fingerprint makes an unrecognized new registration
invalidate a previous inventory too; refreshing this file is not approval to
convert a writer. See docs/state-system/operation-inventory.md.
"""
from __future__ import annotations

import argparse
import ast
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys


SCHEMA = "orgtree.state-operation-inventory/v1"
METHODS = {"get", "post", "put", "patch", "delete", "head", "options", "trace"}
HOOKS = {"on_event", "middleware", "exception_handler"}
REGISTRATION_CALLS = {"add_api_route", "add_route", "add_websocket_route",
                      "add_event_handler", "include_router", "mount"}
# Matched on the CALL NAME, like every other name in this pass: the receiver
# is recorded in `mechanism` rather than used to accept or reject a site.
# `to_thread` is asyncio's worker hand-off. `anyio.to_thread.run_sync` is a
# different call name and is NOT covered by this set.
TASK_CALLS = {"create_task", "ensure_future", "run_in_executor", "submit",
              "call_soon", "call_soon_threadsafe", "call_later", "call_at",
              "to_thread"}
# `to_thread(func, /, *args, **kwargs)` takes its callable POSITIONAL-ONLY, so a
# `func=` keyword is forwarded TO that callable and is not the callable itself.
# These names therefore read the position and never the keyword.
POSITIONAL_ONLY_CALLS = {"to_thread"}
CALLBACK_KEYS = {"callback", "on_exit", "on_result", "on_message", "on_event",
                 "on_input", "on_late", "on_error", "on_complete"}
DATABASE_ROOTS = {"sqlite3", "apsw", "psycopg", "psycopg2", "duckdb", "sqlcipher3"}
LIMITS = [
    "Static Python source sites are not logical attempted-operation counts.",
    "Selectors are branch evidence, not proof that a value is reachable or accepted.",
    "No transitive call graph, exact read/write/predicate set or runtime authority is inferred.",
    "Dynamic factories, indirect callbacks and external/plugin registrations require explicit review and runtime census.",
    "No backend import, connection, service, provider, runtime census or native qualification is performed.",
]


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def expression(node: ast.AST | None) -> str | None:
    return ast.unparse(node) if node is not None else None


def literal_strings(node: ast.AST | None) -> list[str] | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        values = []
        for element in node.elts:
            if not isinstance(element, ast.Constant) or not isinstance(element.value, str):
                return None
            values.append(element.value)
        return values
    return None


def dictionary_value(node: ast.AST | None, key: str) -> ast.AST | None:
    if isinstance(node, ast.Dict):
        for left, right in zip(node.keys, node.values):
            if isinstance(left, ast.Constant) and left.value == key:
                return right
    return None


def argument(call: ast.Call, key: str, position: int | None = None) -> ast.AST | None:
    for keyword in call.keywords:
        if keyword.arg == key:
            return keyword.value
    if position is not None and len(call.args) > position:
        return call.args[position]
    return None


def positional(call: ast.Call, position: int) -> ast.AST | None:
    """The argument at `position`, never a keyword of the same parameter name.

    For a positional-only parameter a same-named keyword belongs to the CALLEE,
    so reading it would name the wrong target. A `*expansion` at or before the
    position makes the index undeterminable and stays unresolved rather than
    reporting the expansion itself as a target.
    """
    if any(isinstance(value, ast.Starred) for value in call.args[:position + 1]):
        return None
    return call.args[position] if len(call.args) > position else None


class ModuleInventory(ast.NodeVisitor):
    def __init__(self, path: str, source: str):
        self.path = path
        self.tree = ast.parse(source, filename=path)
        self.aliases: dict[str, str] = {}
        self.scope: list[str] = []
        self.registrations: list[dict] = []
        self.selectors: list[dict] = []
        self.storage: list[dict] = []
        self.lock_references: list[dict] = []
        self.ordinals: Counter = Counter()
        # Imports are evidence for name resolution only. Local shadowing and
        # computed receiver types are not proven by this pass.
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.aliases[alias.asname or alias.name.split(".")[0]] = (
                        alias.name if alias.asname else alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom) and node.module:
                for alias in node.names:
                    self.aliases[alias.asname or alias.name] = node.module + "." + alias.name

    def name(self, node: ast.AST) -> str:
        if isinstance(node, ast.Name):
            return self.aliases.get(node.id, node.id)
        if isinstance(node, ast.Attribute):
            return self.name(node.value) + "." + node.attr
        return expression(node) or "<unknown>"

    def site(self, node: ast.AST) -> dict:
        return {"path": self.path, "symbol": ".".join(self.scope) or "<module>",
                "line": node.lineno, "end_line": getattr(node, "end_lineno", node.lineno),
                "syntax_sha256": fingerprint(ast.dump(node, include_attributes=False))}

    def registration(self, kind: str, node: ast.AST, **facts) -> None:
        source = self.site(node)
        key = (kind, source["symbol"], json.dumps(facts, sort_keys=True))
        self.ordinals[key] += 1
        identity = json.dumps([self.path, *key, self.ordinals[key]], separators=(",", ":"))
        self.registrations.append({"site_id": fingerprint(identity), "kind": kind,
                                   "source": source, **facts})

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        self.scope.append(node.name)
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                continue
            method = decorator.func.attr
            if method in METHODS | {"api_route", "websocket"} | HOOKS:
                selector = argument(decorator, "path", 0)
                values = literal_strings(selector)
                self.registration(
                    "http" if method in METHODS | {"api_route"} else
                    "websocket" if method == "websocket" else "hook",
                    decorator, receiver=expression(decorator.func.value), method=method,
                    selectors=values, selector_expression=expression(selector),
                    methods_expression=expression(argument(decorator, "methods")),
                    resolution="literal" if values is not None else "unresolved")
        self.generic_visit(node)
        self.scope.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def tools(self, node: ast.AST, value: ast.AST | None) -> None:
        if not isinstance(value, (ast.List, ast.Tuple)):
            self.registration("tool_catalog", node, resolution="unresolved",
                              catalog_expression=expression(value))
            return
        for tool in value.elts:
            names = literal_strings(dictionary_value(tool, "name"))
            schema = dictionary_value(tool, "inputSchema")
            action = dictionary_value(dictionary_value(schema, "properties"), "action")
            enumeration = dictionary_value(action, "enum")
            actions = literal_strings(enumeration)
            self.registration("tool", tool, names=names, actions=actions,
                              action_schema_present=action is not None,
                              action_expression=expression(enumeration),
                              resolution="literal" if names and (action is None or actions is not None)
                              else "unresolved")

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if isinstance(node.target, ast.Name) and node.target.id == "TOOLS":
            self.tools(node, node.value)
        self.generic_visit(node)

    def visit_Assign(self, node: ast.Assign) -> None:
        if any(isinstance(target, ast.Name) and target.id == "TOOLS" for target in node.targets):
            self.tools(node, node.value)
        self.generic_visit(node)

    def visit_Compare(self, node: ast.Compare) -> None:
        operands = [node.left, *node.comparators]
        for index, operator in enumerate(node.ops):
            left, right = operands[index:index + 2]
            for selector, values_node in ((left, right), (right, left)):
                values = literal_strings(values_node)
                if not values:
                    continue
                tools = [value for value in values if value.startswith("orgtree_")]
                selector_name = expression(selector) or ""
                is_action = ((isinstance(selector, ast.Name) and selector.id in {"action", "act", "op"})
                             or (isinstance(selector, ast.Attribute) and selector.attr in {"action", "act", "op"})
                             or (isinstance(selector, ast.Call) and isinstance(selector.func, ast.Attribute)
                                 and selector.func.attr == "get" and selector.args
                                 and literal_strings(selector.args[0]) == ["action"]))
                if tools or is_action:
                    self.selectors.append({"source": self.site(node),
                                           "kind": "tool" if tools else "action",
                                           "selector": selector_name,
                                           "operator": type(operator).__name__,
                                           "values": tools or values})
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        name = self.name(node.func)
        method = name.rsplit(".", 1)[-1]
        if name in {"threading.Thread", "threading.Timer"}:
            target = argument(node, "target" if name.endswith("Thread") else "function", 1)
            self.registration("worker", node, mechanism=name, target=expression(target),
                              resolution="expression" if target is not None else "unresolved")
        elif method in TASK_CALLS | REGISTRATION_CALLS:
            key, position = {
                "add_api_route": ("endpoint", 1), "add_route": ("endpoint", 1),
                "add_websocket_route": ("endpoint", 1), "add_event_handler": ("func", 1),
                "include_router": ("router", 0), "mount": ("app", 1),
                "create_task": ("coro", 0), "ensure_future": ("coro_or_future", 0),
                "run_in_executor": ("func", 1), "submit": ("fn", 0),
                "call_soon": ("callback", 0), "call_soon_threadsafe": ("callback", 0),
                "call_later": ("callback", 1), "call_at": ("callback", 1),
                # The key names the CPython parameter; for a positional-only one
                # it is documentation, never a keyword this pass will match.
                "to_thread": ("func", 0),
            }[method]
            target = (positional(node, position) if method in POSITIONAL_ONLY_CALLS
                      else argument(node, key, position))
            self.registration("registration_call" if method in REGISTRATION_CALLS else "task",
                              node, mechanism=name, target=expression(target),
                              call_expression=expression(node),
                              resolution="expression" if target is not None else "unresolved")
        for keyword in node.keywords:
            if keyword.arg in CALLBACK_KEYS:
                self.registration("callback", node, mechanism=name, argument=keyword.arg,
                                  target=expression(keyword.value), resolution="expression")
        if method in {"connect", "Connection"}:
            root = name.split(".", 1)[0]
            self.storage.append({"source": self.site(node), "factory": name,
                                 "classification": "database_factory" if root in DATABASE_ROOTS
                                 else "unresolved_connect_call",
                                 "arguments_expression": expression(node)})
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr == "DOC_LOCK":
            self.lock_references.append(self.site(node))
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if node.id == "DOC_LOCK":
            self.lock_references.append(self.site(node))


# Outside engine/backend (coordinator ruling on p01-inventory-misses-the-production-routes-mount, 2026-09-24):
# the engine's own top-level modules and engine/winservice run in production too. engine/launch.py mounts routes
# and installs hooks that a backend-only scan could not see. NOT scanned: engine/native/**/oracle (offline
# test-vector generators, never imported by the product) and engine/runtime (the gitignored packaged interpreter).
ENGINE_EXTRA_TREES = ("engine/winservice",)
SKIPPED_PARTS = {"__pycache__", ".venv", "node_modules"}


def module_paths(repo: Path) -> list[Path]:
    """Every module the inventory scans: engine/backend first (its order is unchanged), then the engine's own
    top-level modules, then each extra tree."""
    backend = repo / "engine/backend"
    paths = [p for p in sorted(backend.rglob("*.py")) if not SKIPPED_PARTS & set(p.relative_to(backend).parts)]
    paths += sorted((repo / "engine").glob("*.py"))
    for tree in ENGINE_EXTRA_TREES:
        root = repo / tree
        if root.is_dir():
            paths += [p for p in sorted(root.rglob("*.py")) if not SKIPPED_PARTS & set(p.relative_to(root).parts)]
    return paths


def scan(repo: Path) -> dict:
    backend = repo / "engine/backend"
    if not backend.is_dir():
        raise ValueError("repository has no engine/backend directory")
    modules, registrations, selectors, storage, locks = [], [], [], [], []
    for path in module_paths(repo):
        # Universal newlines make a checkout's CRLF policy irrelevant.
        source = path.read_text(encoding="utf-8-sig")
        relative = path.relative_to(repo).as_posix()
        inventory = ModuleInventory(relative, source)
        inventory.visit(inventory.tree)
        modules.append({"path": relative, "normalized_source_sha256": fingerprint(source)})
        registrations.extend(inventory.registrations)
        selectors.extend(inventory.selectors)
        storage.extend(inventory.storage)
        locks.extend(inventory.lock_references)
    return {"schema": SCHEMA, "limits": LIMITS,
            "qualification": {"runtime_census": False, "conversion_authorized": False,
                              "exact_effect_contracts": "pending per-entry review"},
            "summary": {"modules": len(modules), "registration_sites": len(registrations),
                        "registration_kinds": dict(sorted(Counter(r["kind"] for r in registrations).items())),
                        "unresolved_registrations": sum(r["resolution"] == "unresolved" for r in registrations),
                        "dispatch_selector_sites": len(selectors), "connection_sites": len(storage),
                        "unresolved_connect_calls": sum(r["classification"] == "unresolved_connect_call" for r in storage),
                        "doc_lock_references": len(locks)},
            "modules": modules, "registrations": registrations, "dispatch_selectors": selectors,
            "connection_sites": storage, "doc_lock_references": locks}


def compare(expected: dict, actual: dict) -> dict:
    """A changed source or inventory is a refusal, including unknown syntax."""
    errors = []
    for key in ("schema", "limits", "qualification", "summary", "modules", "registrations",
                "dispatch_selectors", "connection_sites", "doc_lock_references"):
        if expected.get(key) != actual.get(key):
            errors.append(key)
    if set(expected) != set(actual):
        errors.append("document_fields")
    return {"matches": not errors, "changed_sections": errors,
            "qualification": actual["qualification"], "summary": actual["summary"]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", type=Path, help="write a source inventory for review; does not approve it")
    group.add_argument("--check", type=Path, help="refuse if source or inventory differs")
    args = parser.parse_args(argv)
    try:
        actual = scan(args.repo.resolve())
        if args.write:
            args.write.parent.mkdir(parents=True, exist_ok=True)
            args.write.write_text(json.dumps(actual, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            result = {"written": str(args.write), "summary": actual["summary"],
                      "qualification": actual["qualification"]}
        else:
            expected = json.loads(args.check.read_text(encoding="utf-8"))
            if not isinstance(expected, dict):
                raise ValueError("inventory must be a JSON object")
            result = compare(expected, actual)
        print(json.dumps(result, indent=2))
        return 0 if result.get("matches", True) else 1
    except (OSError, ValueError, SyntaxError) as exc:
        print(json.dumps({"error": str(exc), "matches": False}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
