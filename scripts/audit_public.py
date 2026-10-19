"""Scan the index, working files and every reachable Git commit without printing values."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, stderr=subprocess.DEVNULL)

PATTERNS = {
    'provider-key': re.compile(rb'\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})'),
    'private-key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'credential-url': re.compile(rb'https?://[^\s/@:]+:[^\s/@]+@'),
    'bearer-literal': re.compile(rb'Bearer [A-Za-z0-9_+./=-]{32,}'),
    'jwt': re.compile(rb'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}'),
    'personal-windows-path': re.compile(rb'[A-Za-z]:[\\/](?:Users|Projects)[\\/]'),
    'credential-literal': re.compile(rb'(?i)(?:api[_-]?key|auth[_-]?token|password|secret)\s*[=:]\s*[\x22\x27]([A-Za-z0-9_+./=-]{24,})[\x22\x27]'),
}

def check(name, data, issues):
    p = Path(name)
    blocked = (p.name.startswith('.env') and p.name != '.env.example') or p.suffix.lower() in {'.db', '.sqlite', '.pem', '.key', '.log', '.zip'}
    blocked = blocked or p.name in {'local.config.json', 'id_rsa', 'id_ed25519'} or bool(set(p.parts) & {'data', '.local', 'node_modules', 'blueprint-private'})
    if blocked: issues.add((name, 'excluded-file'))
    for label, pattern in PATTERNS.items():
        if pattern.search(data): issues.add((name, label))

def main():
    issues = set()
    paths = git('ls-files', '-z').decode().split('\0')
    for name in filter(None, paths):
        p = ROOT / name
        if p.is_file(): check(name, p.read_bytes(), issues)
        check(name, git('show', ':' + name), issues)
    try: commits = git('rev-list', '--all').decode().split()
    except subprocess.CalledProcessError: commits = []
    seen = set()
    for commit in commits:
        for row in git('ls-tree', '-rz', commit).split(b'\0'):
            if not row: continue
            meta, path = row.split(b'\t', 1)
            mode, kind, oid = meta.split()
            if kind != b'blob': continue
            key = (oid, path)
            if key in seen: continue
            seen.add(key)
            check(path.decode(), git('cat-file', 'blob', oid.decode()), issues)
    for name, label in sorted(issues): print(f'FAIL {label}: {name}')
    print(f'Checked {len(list(filter(None, paths)))} indexed paths and {len(commits)} reachable commits; findings: {len(issues)}. No secret values printed.')
    return 1 if issues else 0

if __name__ == '__main__': sys.exit(main())
