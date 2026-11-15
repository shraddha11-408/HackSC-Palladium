"""Create an auditable UI-only deployment branch without changing this checkout.

Run after committing source changes, then explicitly push replit-ui. Only Git
blobs from the committed allowlist are exported; ignored files cannot enter it.
The complete application and GPU lockfiles stay on the source branch.
"""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BRANCH = 'refs/heads/replit-ui'
FILES = {'.replit', '.gitignore', 'package.json', 'docs/overview/replit.md'}
PREFIXES = ('apps/web/', 'apps/gateway/', 'apps/dashboard/')


def git(*args, input=None, env=None):
    return subprocess.check_output(['git', *args], cwd=ROOT, input=input, env=env)


def main():
    source = git('rev-parse', 'HEAD').decode().strip()
    entries = []
    for entry in git('ls-tree', '-rz', source).split(b'\0'):
        if not entry:
            continue
        metadata, raw_name = entry.split(b'\t', 1)
        name = raw_name.decode()
        if name in FILES or name.startswith(PREFIXES):
            if any(part in {'node_modules', 'dist', '.env', 'data'} for part in Path(name).parts):
                raise RuntimeError(f'Unexpected private/build file in export: {name}')
            entries.append(entry)
    names = {entry.split(b'\t', 1)[1].decode() for entry in entries}
    if not FILES.issubset(names) or 'apps/gateway/server.mjs' not in names:
        raise RuntimeError('Commit the hosting implementation before exporting')
    readme = git('show', f'{source}:docs/overview/replit.md')
    blob = git('hash-object', '-w', '--stdin', input=readme).strip()
    entries.append(b'100644 blob ' + blob + b'\tREADME.md')
    provenance = (f'Palladium UI deployment\nSource commit: {source}\n'
                  'Runtime: Node gateway and built React UI only.\n'
                  'Python API, GPU models and storage remain on Runpod.\n').encode()
    blob = git('hash-object', '-w', '--stdin', input=provenance).strip()
    entries.append(b'100644 blob ' + blob + b'\tDEPLOYMENT_SOURCE.txt')
    try:
        old = git('rev-parse', '--verify', BRANCH).decode().strip()
    except subprocess.CalledProcessError:
        old = None
    with tempfile.TemporaryDirectory(prefix='safesc-ui-index-') as directory:
        env = {**os.environ, 'GIT_INDEX_FILE':str(Path(directory) / 'index')}
        git('read-tree', '--empty', env=env)
        git('update-index', '-z', '--index-info', input=b'\0'.join(entries) + b'\0', env=env)
        tree = git('write-tree', env=env).decode().strip()
    parents = ['-p', old, '-p', source] if old and old != source else ['-p', source]
    commit = git('commit-tree', tree, *parents, '-m', 'Prepare Replit UI').decode().strip()
    git('update-ref', BRANCH, commit, old or '0' * 40)
    print(f'replit-ui {commit}: {len(entries)} committed UI files from {source}')
    print('Current checkout is unchanged. Review the branch, then push origin replit-ui.')


if __name__ == '__main__':
    main()
