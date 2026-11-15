import {useEffect,useState} from 'react';
import {MapPin,ExternalLink} from 'lucide-react';


type Fix=Record<string,any>;
export default function CameraLocation({location:fix,live=false,title='Camera location'}:{location?:Fix;live?:boolean;title?:string}){
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{if(!live)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),10000);return()=>clearInterval(timer)},[live]);
  const measured=typeof fix?.measured_at==='number'?fix.measured_at:NaN;
  const valid=fix?.status==='active'&&typeof fix.latitude==='number'&&Number.isFinite(fix.latitude)&&Math.abs(fix.latitude)<=90&&typeof fix.longitude==='number'&&Number.isFinite(fix.longitude)&&Math.abs(fix.longitude)<=180&&typeof fix.accuracy_m==='number'&&Number.isFinite(fix.accuracy_m)&&fix.accuracy_m>=0&&Number.isFinite(measured);
  const stale=valid&&live&&now-measured>60000;
  const labels:Record<string,string>={disabled:'Location sharing off',denied:'Location permission denied',unavailable:'Phone location unavailable',stale:'Location fix was too old for this event'};
  return <section className="camera-location" aria-label={title}><MapPin size={19}/><div><strong>{title}</strong>
    {valid?<><p>{stale?'Last known position · ':''}{fix.latitude.toFixed(5)}, {fix.longitude.toFixed(5)} <span>±{Math.round(fix.accuracy_m)} m reported accuracy</span></p><small>Measured {new Date(measured).toLocaleString()}. {stale?'Waiting for a fresh phone fix.':'Browser-reported position; indoor accuracy can vary.'}</small></>:<><p>{fix?labels[fix.status]||'No location recorded':'No location recorded'}</p><small>{live?'Enable “Share camera location” on the paired phone. Video continues without location.':'A geotag is saved only when the camera shares a usable location at the event. Earlier uploads are not located automatically.'}</small></>}
    </div>{valid&&<a href={`https://www.openstreetmap.org/?mlat=${fix.latitude}&mlon=${fix.longitude}#map=17/${fix.latitude}/${fix.longitude}`} target="_blank" rel="noreferrer">Open map <ExternalLink size={13}/></a>}</section>
}
