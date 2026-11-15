"""Publish hash-bound adapter versions only; footage and private labels stay local."""
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime,timezone
from pathlib import Path

METRICS=('base_model','base_revision','adapter_sha256','adapter_config_sha256',
    'promotion_passed','nonregression','improved_over_parent','training_examples',
    'unique_training_videos','steps','learning_rate','runtime_seconds','optimization_seconds',
    'optimizer_updates_performed','baseline','candidate','limitations')

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def stage_adapter(adapter,version,selection,folder):
    """Explicit allowlist: never upload a training directory or its raw evaluation."""
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}',version):raise ValueError('Invalid adapter version')
    if selection not in ('selected','candidate','rejected'):raise ValueError('Invalid selection state')
    adapter=Path(adapter);folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    report=json.loads((adapter/'evaluation.json').read_text())
    for name,key in [('adapter_model.safetensors','adapter_sha256'),('adapter_config.json','adapter_config_sha256')]:
        if digest(adapter/name)!=report.get(key):raise ValueError('Adapter artifact hash mismatch')
        # Copy the immutable bytes rather than export the parent training folder.
        with (adapter/name).open('rb') as src,(folder/name).open('xb') as dest:
            import shutil
            shutil.copyfileobj(src,dest)
    metrics={key:report[key] for key in METRICS if key in report}
    manifest={'schema_version':1,'version':version,'selection':selection,
        'created_at':datetime.now(timezone.utc).isoformat(),
        'base_model':report['base_model'],'base_revision':report['base_revision'],
        'adapter_sha256':report['adapter_sha256'],'adapter_config_sha256':report['adapter_config_sha256'],
        'promotion_passed':bool(report.get('promotion_passed')),
        'nonregression':report.get('nonregression'),'publication_changes_live_model':False}
    (folder/'evaluation.json').write_text(json.dumps(metrics,indent=2,allow_nan=False))
    (folder/'manifest.json').write_text(json.dumps(manifest,indent=2,allow_nan=False))
    card=f'''---
base_model: {report['base_model']}
library_name: peft
tags:
- lora
- research
---
# Palladium adapter {version}

Selection at publication: **{selection}**. Publication never changes the running model.
Base revision: `{report['base_revision']}`.
Adapter SHA-256: `{report['adapter_sha256']}`.

This adapter predicts observable actions, not ownership, intent, or legal guilt.
The selected model is an owner-approved research demo; a published candidate may fail evaluation.
See evaluation.json for aggregate held-out results and limitations. Reused research checks are
not independent production validation. No original video, private annotation, or training frame
is included in this model version.
'''
    (folder/'README.md').write_text(card)
    return manifest

def publish_adapter(adapter,version,selection='candidate',repo_id=None,api=None):
    repo_id=repo_id or os.getenv('HF_ADAPTER_REPO','')
    if not repo_id:return {'status':'not_configured','message':'No private Hugging Face adapter repository configured'}
    if api is None:
        from huggingface_hub import HfApi
        token=os.getenv('HF_TOKEN')
        if not token:raise ValueError('Hugging Face publishing token is not configured')
        api=HfApi(token=token)
    api.create_repo(repo_id=repo_id,repo_type='model',private=True,exist_ok=True)
    if api.model_info(repo_id).private is not True:raise ValueError('Adapter repository must be private')
    with tempfile.TemporaryDirectory(prefix='safesc-adapter-publish-') as directory:
        manifest=stage_adapter(adapter,version,selection,directory)
        prefix='versions/'+version
        files=api.list_repo_files(repo_id=repo_id,repo_type='model')
        if prefix+'/manifest.json' in files:
            # Version names are immutable: a retry may reuse only identical weights.
            import httpx
            url=f'https://huggingface.co/{repo_id}/resolve/main/{prefix}/manifest.json'
            token=getattr(api,'token',None) or os.getenv('HF_TOKEN')
            with httpx.Client(timeout=60,follow_redirects=True) as client:
                response=client.get(url,headers={'Authorization':'Bearer '+token} if token else {})
                response.raise_for_status();existing=response.json()
            if existing.get('adapter_sha256')!=manifest['adapter_sha256'] or existing.get('adapter_config_sha256')!=manifest['adapter_config_sha256']:
                raise ValueError('Adapter version already names different weights')
            tags={ref.name:ref.target_commit for ref in api.list_repo_refs(repo_id=repo_id,repo_type='model').tags}
            revision=tags.get(version) or api.model_info(repo_id).sha
        else:
            commit=api.upload_folder(repo_id=repo_id,repo_type='model',folder_path=directory,
                path_in_repo=prefix,commit_message='Publish immutable adapter '+version)
            revision=commit.oid
        api.create_tag(repo_id=repo_id,repo_type='model',tag=version,revision=revision,exist_ok=True)
        published=api.list_repo_files(repo_id=repo_id,repo_type='model',revision=version)
        required={prefix+'/'+name for name in ('adapter_model.safetensors','adapter_config.json','evaluation.json','manifest.json','README.md')}
        if not required<=set(published):raise RuntimeError('Published adapter version is incomplete')
        return {'status':'published','repo_id':repo_id,'revision':revision,'tag':version,
            'subfolder':prefix,'adapter_sha256':manifest['adapter_sha256'],
            'selection':selection,'private':True,'url':f'https://huggingface.co/{repo_id}/tree/{version}/{prefix}',
            'deployed':False}
