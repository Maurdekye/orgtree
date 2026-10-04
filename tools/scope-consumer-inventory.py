"""Exact capability-source inventory. New reads need an explicit classification.

This scans source syntax, not inferred runtime types. Scope origins and effective
view bindings are retained, so a later alias does not erase its source. The
manifest pins each expression and occurrence, not whole functions or files.
"""
from __future__ import annotations

import ast
from collections import Counter
import json
from pathlib import Path

METHODS = frozenset({'capability_scope', 'display_scope', 'effective_agent',
                     'effective_scope'})
CATEGORIES = frozenset({'effective', 'configured', 'unrelated'})


def scan_text(source: str, path: str) -> list[dict]:
    tree = ast.parse(source, filename=path)
    parents = {child: parent for parent in ast.walk(tree)
               for child in ast.iter_child_nodes(parent)}
    matches = []
    for node in ast.walk(tree):
        kind = None
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant):
            if node.slice.value in ('scope', 'configured_scope'):
                kind = 'scope-field'
        elif isinstance(node, ast.Call):
            func = node.func
            if (isinstance(func, ast.Attribute) and func.attr == 'get' and node.args
                    and isinstance(node.args[0], ast.Constant)
                    and node.args[0].value in ('scope', 'configured_scope')):
                kind = 'scope-field'
            elif ((isinstance(func, ast.Attribute) and func.attr in METHODS)
                  or (isinstance(func, ast.Name) and func.id in METHODS)):
                kind = 'effective-binding'
            elif (isinstance(func, ast.Attribute) and func.attr == 'run'
                  and isinstance(func.value, ast.Name) and func.value.id == 'scope_actions'):
                kind = 'locked-action-binding'
            elif isinstance(func, ast.Attribute) and func.attr == 'scope':
                kind = 'scope-call'
        elif isinstance(node, ast.Attribute) and node.attr in ('scope', 'configured_scope'):
            if not (isinstance(parents.get(node), ast.Call) and parents[node].func is node):
                kind = 'scope-attribute'
        elif isinstance(node, ast.Constant) and node.value in METHODS:
            kind = 'effective-method-binding'
        if kind is None:
            continue
        owners = []
        ancestor = node
        while ancestor in parents:
            ancestor = parents[ancestor]
            if isinstance(ancestor, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                owners.append(ancestor.name)
        matches.append(dict(path=path, owner='.'.join(reversed(owners)) or '<module>',
                            kind=kind, expression=ast.unparse(node), line=node.lineno))
    return sorted(matches, key=lambda m: (m['path'], m['line'], m['expression'], m['kind']))


def scan(root: Path) -> list[dict]:
    matches = []
    for path in sorted((root / 'engine/backend/orgtree').rglob('*.py')):
        matches.extend(scan_text(path.read_text(encoding='utf-8-sig'),
                                 path.relative_to(root).as_posix()))
    return matches


def key(match: dict) -> tuple[str, ...]:
    return tuple(match[field] for field in ('path', 'owner', 'kind', 'expression'))


def validate(matches: list[dict], entries: list[dict]) -> list[str]:
    issues = []
    for entry in entries:
        if entry.get('classification') not in CATEGORIES or not str(entry.get('reason', '')).strip():
            issues.append(f'incomplete classification: {key(entry)!r}')
    actual = Counter(key(match) for match in matches)
    expected = Counter(key(entry) for entry in entries)
    issues.extend(f'unclassified expression ({count}): {identity!r}'
                  for identity, count in sorted((actual - expected).items()))
    issues.extend(f'stale classification ({count}): {identity!r}'
                  for identity, count in sorted((expected - actual).items()))
    return issues


def main() -> int:
    import argparse
    from assert_repo_import import assert_repo_import
    root = Path(__file__).resolve().parents[1]
    provenance = assert_repo_import(root)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json-output', type=Path)
    args = parser.parse_args()
    matches = scan(root)
    entries = json.loads((root / 'tools/scope-consumers-python.json').read_text())['entries']
    issues = validate(matches, entries)
    result = dict(import_provenance=provenance.as_dict(), matches=matches,
                  classifications=entries, issues=issues)
    if args.json_output:
        args.json_output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(dict(matches=len(matches), classifications=len(entries), issues=issues)))
    return int(bool(issues))


if __name__ == '__main__':
    raise SystemExit(main())
