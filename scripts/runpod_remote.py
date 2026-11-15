"""SSH into the recorded Palladium pod; never copy provider administrative tokens."""
import json
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def ssh_args():
    pod = json.loads((ROOT / 'data/runpod-deployment.json').read_text())
    direct = pod['ssh'].get('direct')
    if not direct:
        raise RuntimeError('Refresh pod metadata; direct SSH is not ready')
    return ['ssh','-i',str(ROOT/'data/deploy_key'),'-p',str(direct['port']),
        '-o','BatchMode=yes','-o','ConnectTimeout=20','-o','ServerAliveInterval=20',
        '-o','StrictHostKeyChecking=accept-new','-o',f'UserKnownHostsFile={ROOT}/data/runpod_known_hosts',
        f"{direct['username']}@{direct['host']}"]

def upload_source():
    archive = ROOT / 'data/runpod-source.tar.gz'
    def include(info):
        if Path(info.name).parts[:2] in [('docs','local'),('docs','screenshots')]:return None
        if any(x in ['node_modules','__pycache__','.pytest_cache','.venv','.git'] for x in Path(info.name).parts):
            return None
        return info
    with tarfile.open(archive,'w:gz') as tar:
        for name in ['apps','ml','scripts','docs','tests','patches','evaluation','pyproject.toml','uv.lock','model-lock.json','requirements-gpu-control.lock.txt','README.md','.env.example','.gitignore']:
            if (ROOT/name).exists():tar.add(ROOT/name,arcname=name,filter=include)
    subprocess.run(ssh_args()+['mkdir -p /workspace/safesc'],check=True)
    with archive.open('rb') as stream:
        subprocess.run(ssh_args()+['tar --no-same-owner -xzf - -C /workspace/safesc'],stdin=stream,check=True)

if __name__ == '__main__':
    if sys.argv[1:] == ['--upload-source']:
        upload_source()
    else:
        subprocess.run(ssh_args()+sys.argv[1:],check=True)
