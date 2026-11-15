/** Opt-in camera location. The caller starts this only after camera pairing. */
export type CameraLocationStatus='active'|'denied'|'unavailable'|'disabled';
export type CameraLocationFix={latitude:number,longitude:number,accuracy_m:number,measured_at:number};
export type CameraLocationState={status:CameraLocationStatus|'requesting',message:string,fix?:CameraLocationFix};
type LocationMessage={type:'geolocation',status:CameraLocationStatus}&Partial<CameraLocationFix>;

export function shareCameraLocation(send:(message:LocationMessage)=>void,onState:(state:CameraLocationState)=>void,provider:Geolocation|undefined=navigator.geolocation){
  let stopped=false,permissionDenied=false,watch:number|undefined,timer=0,lastSent=-Infinity,newestMeasurement=0,lastStatus:CameraLocationStatus|undefined,pending:CameraLocationFix|null=null,fallbackPending=false;
  function clearPending(){if(timer)window.clearTimeout(timer);timer=0;pending=null}
  function status(value:CameraLocationStatus,message:string){clearPending();if(lastStatus!==value){send({type:'geolocation',status:value});lastStatus=value}onState({status:value,message})}
  function flush(){timer=0;if(stopped||!pending)return;const fix=pending;pending=null;lastSent=performance.now();lastStatus='active';send({type:'geolocation',status:'active',...fix});onState({status:'active',fix,message:`Location fix · approximately ±${Math.round(fix.accuracy_m)} m`})}
  onState({status:'requesting',message:'Choose Allow in the location prompt. Waiting for a phone location fix…'});
  if(!provider){status('unavailable','Location is unavailable in this browser. Camera video continues.');return()=>{stopped=true;status('disabled','Location sharing is off.')}}
  const receive=(position:GeolocationPosition)=>{
    if(stopped||permissionDenied)return;const {latitude,longitude,accuracy}=position.coords,measured=position.timestamp;
    if(![latitude,longitude,accuracy,measured].every(Number.isFinite)||Math.abs(latitude)>90||Math.abs(longitude)>180||accuracy<0||measured<=0){status('unavailable','The location fix is invalid. Camera video continues.');return}
    if(measured<newestMeasurement)return;newestMeasurement=measured;
    pending={latitude,longitude,accuracy_m:accuracy,measured_at:measured};
    const delay=5000-(performance.now()-lastSent);
    if(delay<=0)flush();else if(!timer)timer=window.setTimeout(flush,delay);
  };
  const failure=(error:GeolocationPositionError)=>{
    if(stopped||permissionDenied)return;
    if(error.code===1){permissionDenied=true;status('denied','Location permission was denied. Allow location in this site’s browser permissions, then retry. Camera video continues.');if(watch!==undefined)provider.clearWatch(watch);watch=undefined}
    else{
      status('unavailable','GPS is taking longer than expected. Trying the browser’s approximate location; camera video continues.');
      if(!fallbackPending&&provider.getCurrentPosition){fallbackPending=true;provider.getCurrentPosition(position=>{fallbackPending=false;receive(position)},()=>{fallbackPending=false;if(!stopped&&!permissionDenied)onState({status:'unavailable',message:'No phone location is available yet. Retry outdoors or set the recording area during review. Camera video continues.'})},{enableHighAccuracy:false,timeout:20000,maximumAge:5000})}
    }
  };
  try{watch=provider.watchPosition(receive,failure,{enableHighAccuracy:true,timeout:30000,maximumAge:5000});if(permissionDenied&&watch!==undefined){provider.clearWatch(watch);watch=undefined}}
  catch{status('unavailable','Location could not start. Camera video continues.')}
  return()=>{if(stopped)return;stopped=true;clearPending();if(watch!==undefined)provider.clearWatch(watch);watch=undefined;status('disabled','Location sharing is off.')};
}
