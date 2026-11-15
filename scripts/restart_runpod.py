"""Run on the GPU host: restart only a verified idle Palladium API process."""
import argparse,os,signal,sqlite3,subprocess,time
from pathlib import Path
import httpx
from dotenv import dotenv_values

def main():
    p=argparse.ArgumentParser();p.add_argument('--pid',type=int,required=True);a=p.parse_args()
    root=Path(__file__).resolve().parents[1];env=dotenv_values(root/'.env')
    token=env.get('APP_TOKEN') or (root/'data/app_token').read_text().strip()
    h=httpx.get('http://127.0.0.1:8000/api/health',headers={'Authorization':'Bearer '+token},timeout=10);h.raise_for_status()
    if h.json()['active_sources']:raise RuntimeError('Active source: restart deferred')
    with sqlite3.connect(root/'data/safesc.db') as c:
        if c.execute("SELECT count(*) FROM job WHERE status IN ('queued','running','cancelling')").fetchone()[0]:raise RuntimeError('Pending GPU work: restart deferred')
        if c.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='learningrun'").fetchone()[0]:
            if c.execute("SELECT count(*) FROM learningrun WHERE status IN ('preparing','queued','running','cancelling')").fetchone()[0]:
                raise RuntimeError('Active training preparation or cancellation: restart deferred')
    command=Path(f'/proc/{a.pid}/cmdline').read_bytes()
    if b'uvicorn' not in command or b'apps.api.main:app' not in command:raise RuntimeError('Unexpected process identity')
    os.kill(a.pid,signal.SIGTERM)
    for _ in range(150):
        try:os.kill(a.pid,0)
        except ProcessLookupError:break
        time.sleep(.2)
    else:raise RuntimeError('Previous API did not exit')
    with (root/'data/api.log').open('ab') as log:
        process=subprocess.Popen(['bash','scripts/start_runpod.sh'],cwd=root,stdout=log,stderr=log,start_new_session=True)
    print('Restarted idle API, PID',process.pid)

if __name__=='__main__':main()
