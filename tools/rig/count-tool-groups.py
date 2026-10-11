"""Count captured Claude first-request parts using an explicitly supplied tokenizer.

Usage: python -I tools/rig/count-tool-groups.py <evidence-dir> <tokenize-url>
Only POST /tokenize is used, never inference. Obtain permission before using a
user-owned server. Counts exclude chat-template framing and are not billed usage.
"""
import hashlib
import json
import pathlib
import sys
import urllib.parse
import urllib.request

root = pathlib.Path(sys.argv[1])
url = sys.argv[2]
if urllib.parse.urlparse(url).path != '/tokenize':
    raise SystemExit('Expected an explicit /tokenize URL')
cache_path = root / 'tokenizer-cache.json'
cache = json.loads(cache_path.read_text(encoding='utf-8')) if cache_path.exists() else {}


def count(text):
    if not text:
        return 0
    key = hashlib.sha256((url + '\n' + text).encode()).hexdigest()
    if key not in cache:
        req = urllib.request.Request(url, data=json.dumps({'content': text, 'add_special': False}).encode(),
                                     headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=60) as response:
            cache[key] = len(json.load(response)['tokens'])
        cache_path.write_text(json.dumps(cache), encoding='utf-8')
    return cache[key]


def text_parts(content):
    if isinstance(content, str):
        return [content]
    return [part.get('text', '') for part in content or [] if isinstance(part, dict)]


rows = []
for entry in json.loads((root / 'manifest.json').read_text(encoding='utf-8')):
    if entry['harness'] != 'cc':
        continue
    body = json.loads(pathlib.Path(entry['body']).read_text(encoding='utf-8'))
    parts = {'system': sum(map(count, text_parts(body.get('system')))),
             'messages': sum(count(text) for message in body.get('messages', [])
                             for text in text_parts(message.get('content'))),
             'orgtree_tools': 0, 'native_tools': 0}
    for tool in body.get('tools', []):
        function = {'name': tool['name'], 'description': tool.get('description', ''),
                    'parameters': tool.get('input_schema', {})}
        category = 'orgtree_tools' if 'orgtree_' in tool['name'] else 'native_tools'
        parts[category] += count(json.dumps({'type': 'function', 'function': function}, ensure_ascii=False))
    rows.append({'scope': entry['mode'], **parts, 'total_without_chat_template': sum(parts.values())})
report = {'method': 'Exact tokenizer counts of individual text/tool parts; sum excludes chat-template framing.',
          'endpoint': url, 'rows': rows}
(root / 'token-counts.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))
