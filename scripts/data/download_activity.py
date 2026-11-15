"""Reproducible, bounded download of official public LAPD records near USC.

Only whitelisted non-demographic fields are requested. Raw pages are compressed
locally; the app reads a small normalized SQLite snapshot, not the city APIs.
"""
import gzip
import hashlib
import json
import re
import sqlite3
import sys
import time
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/activity'
DATASETS = [('63jg-8b9z','Crime Data from 2010 to 2019',False),
            ('2nrs-mtv8','Crime Data from 2020 to 2024',False),
            ('k7nn-b2ep','LAPD NIBRS Offenses Dataset',True)]

def inside(lon, lat, ring):
    """Boundary-inclusive ray casting; public coordinates are approximate."""
    result = False
    for (x1,y1),(x2,y2) in zip(ring, ring[1:]):
        cross=(lon-x1)*(y2-y1)-(lat-y1)*(x2-x1)
        if abs(cross)<1e-12 and min(x1,x2)<=lon<=max(x1,x2) and min(y1,y2)<=lat<=max(y1,y2):return True
        if (y1>lat)!=(y2>lat) and lon < (x2-x1)*(lat-y1)/(y2-y1)+x1:result=not result
    return result

def category(description):
    text=description.upper()
    if any(t in text for t in ['RAPE','SEXUAL','SEX OFF','SODOMY','LEWD','FONDL','COPULATION']):return 'Sexual offense'
    if 'ROBBERY' in text:return 'Robbery'
    if any(t in text for t in ['HOMICIDE','MURDER','MANSLAUGHTER']):return 'Homicide'
    if any(t in text for t in ['ASSAULT','BATTERY','INTIMIDATION','THREAT','BRANDISH']):return 'Assault or threat'
    if any(t in text for t in ['VEHICLE','MOTOR VEH','CARJACK']):return 'Vehicle-related report'
    if any(t in text for t in ['THEFT','BURGLARY','SHOPLIFT','LARCENY','PICKING','PURSE']):return 'Theft or burglary'
    if any(t in text for t in ['VANDAL','ARSON','DAMAGE']):return 'Property damage'
    if any(t in text for t in ['FRAUD','IDENTITY','FORGERY','CREDIT CARD','EMBEZZLE']):return 'Fraud or forgery'
    return 'Other reported activity'

def normalize(row, ds, nibrs, ring):
    lat=float(row.get('hndrdth_lat' if nibrs else 'lat',0))
    lon=float(row.get('hndrdth_lon' if nibrs else 'lon',0))
    if not inside(lon,lat,ring):return None,'outside_boundary'
    occurred=str(row.get('date_occ',''))[:10]
    try:day=date.fromisoformat(occurred)
    except ValueError:return None,'invalid_date'
    if day<date(2010,1,1) or day>date.today():return None,'outside_date_range'
    case=re.sub(r'\s+','',str(row.get('caseno' if nibrs else 'dr_no',''))).upper()
    if not case:return None,'missing_case'
    offense=row.get('nibr_description' if nibrs else 'crm_cd_desc','Unspecified classification')
    stamp=str(row.get('time_occ','')).zfill(4)
    valid_time=len(stamp)==4 and stamp.isdigit() and int(stamp[:2])<24 and int(stamp[2:])<60
    return {'id':hashlib.sha256(('lapd:'+case).encode()).hexdigest()[:24], 'case_number':case,
        'occurred':occurred,'reported':str(row.get('date_rptd',''))[:10],
        'time':stamp[:2]+':'+stamp[2:] if valid_time else None,
        'lat':lat,'lon':lon,'category':category(offense),'offenses':[offense],
        'sources':[{'dataset':ds,'url':f'https://data.lacity.org/d/{ds}'}],
        'system':'NIBRS' if nibrs else 'Legacy'},None

def run():
    OUT.mkdir(exist_ok=True,parents=True)
    boundary=json.loads((ROOT/'docs/upc-lyft-boundary.geojson').read_text())
    ring=boundary['geometry']['coordinates'][0]
    xs,ys=zip(*ring); bbox=[min(xs)-.0002,min(ys)-.0002,max(xs)+.0002,max(ys)+.0002]
    records={};quality=Counter();sources=[]
    with httpx.Client(timeout=120,follow_redirects=True,headers={'User-Agent':'Palladium-USC-Hackathon/0.1'}) as client:
        for ds,title,nibrs in DATASETS:
            la,lo=('hndrdth_lat','hndrdth_lon') if nibrs else ('lat','lon')
            fields=f'caseno,uniquenibrno,date_occ,date_rptd,time_occ,{la},{lo},nibr_code,nibr_description' if nibrs else f'dr_no,date_occ,date_rptd,time_occ,{la},{lo},crm_cd,crm_cd_desc'
            where=f'{la} between {bbox[1]} and {bbox[3]} AND {lo} between {bbox[0]} and {bbox[2]} AND date_occ >= "2010-01-01T00:00:00" AND date_occ < "{date.today().isoformat()}T23:59:59"'
            source={'id':ds,'name':title,'url':f'https://data.lacity.org/d/{ds}','select':fields,'where':where,'downloaded_rows':0,'pages':[]}
            offset=0
            while True:
                query_key=hashlib.sha256((fields+where).encode()).hexdigest()[:10]
                cache=OUT/f'{ds}-{query_key}-{offset:07d}.json.gz'
                if cache.exists(): raw=gzip.decompress(cache.read_bytes())
                else:
                    params={'$select':fields,'$where':where,'$order':('caseno,uniquenibrno' if nibrs else 'dr_no'),'$limit':10000,'$offset':offset}
                    for attempt in range(4):
                        try:
                            response=client.get(f'https://data.lacity.org/resource/{ds}.json',params=params);response.raise_for_status();raw=response.content;break
                        except httpx.HTTPError:
                            if attempt==3:raise
                            time.sleep(2**attempt)
                    # Validate JSON before persisting a page.
                    json.loads(raw);cache.write_bytes(gzip.compress(raw))
                rows=json.loads(raw);source['downloaded_rows']+=len(rows)
                source['pages'].append({'file':cache.name,'sha256':hashlib.sha256(raw).hexdigest(),'rows':len(rows)})
                for row in rows:
                    try:item,reason=normalize(row,ds,nibrs,ring)
                    except (ValueError,TypeError):item,reason=None,'invalid_coordinates'
                    if reason:quality[reason]+=1;continue
                    previous=records.get(item['id'])
                    if previous:
                        quality['merged_same_case_rows']+=1
                        # Prefer the current system, retain every classification/source.
                        combined=item if nibrs else previous
                        combined['offenses']=sorted(set(previous['offenses']+item['offenses']))
                        combined['sources']=list({s['dataset']:s for s in previous['sources']+item['sources']}.values())
                        records[item['id']]=combined
                    else:records[item['id']]=item
                print(ds,offset,len(rows),'unique in area',len(records),flush=True)
                if len(rows)<10000:break
                offset+=len(rows)
            sources.append(source)
    temporary=OUT/'activity-building.sqlite';temporary.unlink(missing_ok=True)
    with sqlite3.connect(temporary) as db:
        db.execute('CREATE TABLE incidents (id TEXT PRIMARY KEY, case_number TEXT, occurred TEXT, reported TEXT, time TEXT, lat REAL, lon REAL, category TEXT, offenses TEXT, sources TEXT, system TEXT)')
        for item in records.values():
            values={**item,'offenses':json.dumps(item['offenses']),'sources':json.dumps(item['sources'])}
            db.execute('INSERT INTO incidents VALUES (:id,:case_number,:occurred,:reported,:time,:lat,:lon,:category,:offenses,:sources,:system)',values)
        db.execute('CREATE INDEX occurred_idx ON incidents(occurred)')
    temporary.replace(OUT/'activity.sqlite')
    dates=sorted(i['occurred'] for i in records.values())
    metadata={'downloaded_at':datetime.now(timezone.utc).isoformat(),'count':len(records),'date_min':dates[0],'date_max':dates[-1],
        'boundary':boundary,'sources':sources,'quality':dict(quality),'sqlite_bytes':(OUT/'activity.sqlite').stat().st_size,
        'sqlite_sha256':hashlib.sha256((OUT/'activity.sqlite').read_bytes()).hexdigest(),
        'categories':dict(Counter(i['category'] for i in records.values())),
        'years':dict(sorted(Counter(i['occurred'][:4] for i in records.values()).items())),
        'notes':['Reported incidents, not verified findings or personal risk. Missing or unreported events are absent.',
            'Locations are approximate, generally rounded to a hundred block; several reports can share one marker.',
            'Occurrence times are as listed by the source and can be uncertain; midnight may reflect an estimated or unspecified time.',
            'Current published UPC Lyft boundary is applied to every historical year; it is a digitized approximation, not a ride-eligibility guarantee.',
            'Legacy and NIBRS reporting systems differ. NIBRS offenses are grouped by exact case number; matching legacy case numbers are merged. Other duplicates may remain.',
            'This is a current data snapshot, not a historical as-of dataset. Report date is retained for later leakage-aware forecasting.',
            'No forecasts or street safety ratings are displayed. No victim demographics or precise addresses were downloaded.']}
    (OUT/'metadata.json').write_text(json.dumps(metadata,indent=2))
    print(json.dumps({k:metadata[k] for k in ['count','date_min','date_max','sqlite_bytes','quality','years']},indent=2))

if __name__=='__main__':run()
