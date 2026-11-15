"""Conservative local stop guard. Keeps provider credentials off the GPU worker.

Requires this Mac to remain awake and online. This is not a provider billing cap.
Never changes payments, automatic top-ups, or any resource besides the recorded pod.
"""
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]

def main():
    while True:
        try:
            config = json.loads((ROOT/'data/runpod-budget.json').read_text())
            pod = json.loads((ROOT/'data/runpod-deployment.json').read_text())
            created = datetime.fromisoformat(pod['createdAt'].replace('Z','+00:00'))
            elapsed = max(0,(datetime.now(timezone.utc)-created).total_seconds()/3600)
            estimated = elapsed * config['conservative_hourly_usd']
            end = datetime.fromisoformat(config['stop_at_utc'].replace('Z','+00:00'))
            must_stop = estimated >= config['authorized_budget_usd']-config['reserve_usd'] or datetime.now(timezone.utc)>=end
            state={'checked_at':datetime.now(timezone.utc).isoformat(),'estimated_spend_usd':round(estimated,3),
                'budget_usd':config['authorized_budget_usd'],'stop_required':must_stop,
                'note':'Estimate assumes continuous running; storage persists after stop; not a provider balance.'}
            (ROOT/'data/runpod-budget-status.json').write_text(json.dumps(state,indent=2))
            if must_stop:
                token=dotenv_values(ROOT/'.env')['RUNPOD_TOKEN']
                response=httpx.post(f"https://api.runpod.io/v2/pods/{pod['id']}/action",
                    headers={'Authorization':f'Bearer {token}'},json={'action':'stop'},timeout=40)
                if response.status_code==200:
                    print('Stopped Palladium GPU at budget reserve or requested Sunday deadline.',flush=True)
                    return
                raise RuntimeError(f'Stop returned HTTP {response.status_code}')
        except Exception as error:
            print(datetime.now(timezone.utc).isoformat(),type(error).__name__,str(error),flush=True)
        time.sleep(60)

if __name__=='__main__':
    main()
