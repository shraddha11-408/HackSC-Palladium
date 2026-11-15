// Only the incident location helper from main's campus model is needed by the live incident cards.
export function incidentLocation(incident, sourceKind) {
  const supplied=incident.record?.reviewer_location;
  if(supplied?.active===true&&supplied.provenance==='reviewer_supplied'&&typeof supplied.label==='string'&&supplied.label.trim()&&[supplied.latitude,supplied.longitude].every(v=>typeof v==='number'&&Number.isFinite(v))&&Math.abs(supplied.latitude)<=90&&Math.abs(supplied.longitude)<=180){
    return {point:[supplied.longitude,supplied.latitude],accuracy:null,measuredAt:null,provenance:'reviewer_supplied',label:supplied.label.trim()};
  }
  if (sourceKind === 'upload' || sourceKind === 'rtsp') return null;
  const fix = incident.record?.geolocation;
  if (!fix || fix.status !== 'active' || fix.provenance !== 'browser_permission') return null;
  if (![fix.latitude,fix.longitude,fix.accuracy_m,fix.measured_at].every(v=>typeof v==='number'&&Number.isFinite(v))) return null;
  if (Math.abs(fix.latitude)>90 || Math.abs(fix.longitude)>180 || fix.accuracy_m<0) return null;
  return {point:[fix.longitude,fix.latitude], accuracy:fix.accuracy_m, measuredAt:fix.measured_at, provenance:'browser_permission',label:'Camera-reported position'};
}
