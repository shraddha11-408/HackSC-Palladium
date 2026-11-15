"""Vultr control. Never prints credentials. Provision only with --deploy."""
import argparse
import json
import os
import subprocess
from pathlib import Path
import httpx
from dotenv import load_dotenv

load_dotenv()
ROOT = Path(__file__).resolve().parents[1]

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--deploy', action='store_true')
    p.add_argument('--region')
    p.add_argument('--plan',default='vcg-a40-24c-120g-48vram')
    args = p.parse_args()
    key = os.environ.get('VULTR_API_KEY')
    if not key:
        raise SystemExit('VULTR_API_KEY is missing')
    with httpx.Client(base_url='https://api.vultr.com/v2', headers={'Authorization': f'Bearer {key}'}, timeout=40) as c:
        def get(path):
            r = c.get(path)
            if r.is_error:
                raise SystemExit(f'Vultr {path}: HTTP {r.status_code}; check key and IP allowlist')
            return r.json()
        account = get('/account')['account']
        print(json.dumps({k:account.get(k) for k in ['balance','pending_charges','remaining_credit']}))
        instances = get('/instances')['instances']
        print('Existing instances:', json.dumps([{k:i.get(k) for k in ['id','label','plan','region','main_ip','status']} for i in instances]))
        # A40/A100 plans are classified as vdm despite their vcg- IDs. Never filter only type=vcg.
        plan = next((x for x in get('/plans?type=all&per_page=500')['plans'] if x['id']==args.plan), None)
        if not plan:
            raise SystemExit('Configured GPU plan unavailable')
        hourly = float(plan.get('hourly_cost') or float(plan['monthly_cost'])/730)
        print(json.dumps({'plan':plan['id'],'hourly_estimate':hourly,'60h_estimate':60*hourly}))
        regions = get('/regions')['regions']
        available = []
        for r in sorted(regions,key=lambda x: (x['id'] not in ['lax','sjc','sea','dfw','ord'],x['id'])):
            if plan.get('locations') and r['id'] not in plan['locations']:
                continue
            if plan['id'] in get(f"/regions/{r['id']}/availability").get('available_plans',[]):
                available.append(r['id'])
                if len(available)>=3:
                    break
        print('Available regions:',available)
        if not args.deploy:
            return
        if any(i['label']=='safesc-gpu' for i in instances):
            raise SystemExit('Palladium instance already exists; refusing duplicate')
        if hourly>2 or not available:
            raise SystemExit('Price guard or availability guard blocked provisioning')
        keypath=ROOT/'data'/'deploy_key'
        keypath.parent.mkdir(exist_ok=True)
        if not keypath.exists():
            subprocess.run(['ssh-keygen','-t','ed25519','-N','','-f',str(keypath)],check=True,capture_output=True)
        public_key=keypath.with_suffix('.pub').read_text().strip()
        existing=next((k for k in get('/ssh-keys').get('ssh_keys',[]) if k.get('ssh_key','').strip()==public_key),None)
        if existing:
            sshid=existing['id']
        else:
            response=c.post('/ssh-keys',json={'name':'safesc-deploy','ssh_key':public_key})
            response.raise_for_status()
            sshid=response.json()['ssh_key']['id']
        osid=next(x['id'] for x in get('/os')['os'] if x['name'].startswith('Ubuntu 24.04') and 'x64' in x['name'])
        response=c.post('/instances',json={'region':args.region or available[0],'plan':plan['id'],'os_id':osid,'label':'safesc-gpu','hostname':'safesc','sshkey_id':[sshid],'enable_ipv6':False,'backups':'disabled'})
        if response.is_error:
            raise SystemExit(f'Provisioning refused: HTTP {response.status_code}: {response.json().get("error","Unknown provider error")}')
        response.raise_for_status()
        instance=response.json()['instance']
        safe={k:instance.get(k) for k in ['id','label','plan','region','main_ip','status','date_created']}
        (ROOT/'data'/'deployment.json').write_text(json.dumps(safe,indent=2))
        print('Provisioned:',json.dumps(safe))

if __name__=='__main__': main()
