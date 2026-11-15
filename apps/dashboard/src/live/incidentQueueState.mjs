import {requiresReview} from './responseState.mjs';
import {incidentLocation} from './campusModel.mjs';
// Display actual stored inference, separately from reviewer labels and decisions.
function modelAssessment(record) {
  const analysis=record.moss_analysis;
  if(analysis?.status==='completed'&&analysis.kind==='moss_native_full_clip'&&analysis.model?.name==='MOSS-VL-Realtime'&&analysis.source_sha256&&analysis.source_sha256===record.source_sha256&&typeof analysis.text==='string'&&analysis.text.trim()){
    return {text:analysis.text.trim(),source:'MOSS · full recording analysis'};
  }
  const notes=(Array.isArray(record.moss_observations)?record.moss_observations:[])
    .filter(note=>note.model==='MOSS-VL-Realtime'&&typeof note.text==='string'&&note.text.trim())
    .map(note=>note.text.trim());
  if(notes.length)return {text:notes.join(' '),source:'MOSS · live observations'};
  // Requested/bookmarked context is not an AI prediction.
  const event=record.observable_events?.[0]?.observation;
  if(record.trigger_origin!=='reviewer'&&typeof event==='string'&&event.trim()){
    return {text:event.trim(),source:record.observation_model?.name?'Visual verifier · initial assessment':'AI · initial observation'};
  }
  return null;
}

export function deriveIncidentCard(incident) {
  const record=incident.record||{};
  const manual=record.trigger_origin==='reviewer';
  const initialObservation=typeof record.observable_events?.[0]?.observation==='string'?record.observable_events[0].observation:null;
  const label=record.reviewed_label;
  const reviewed=!!label&&typeof label.title==='string'&&label.title.trim().length>0;
  const assessment=modelAssessment(record);
  const showAssessment=!!assessment&&['pending','needs_review'].includes(incident.review_status);
  const labelVisible=reviewed&&!showAssessment;
  const tags=labelVisible&&Array.isArray(label.tags)?label.tags.filter(t=>typeof t==='string'&&t.trim()).map(t=>t.trim()):[];
  const sentence=assessment?.text.match(/^.*?[.!?](?:\s|$)/s)?.[0]?.trim()||assessment?.text||'';
  const modelTitle=sentence.length>150?sentence.slice(0,147).trimEnd()+'…':sentence;
  const remaining=assessment?.text.slice(sentence.length).trim();
  const gps=record.geolocation;
  let locationLabel=null;
  if(gps){
    const fixed=gps.status==='active'&&typeof gps.latitude==='number'&&Number.isFinite(gps.latitude)&&Math.abs(gps.latitude)<=90&&typeof gps.longitude==='number'&&Number.isFinite(gps.longitude)&&Math.abs(gps.longitude)<=180&&Number.isFinite(gps.accuracy_m)&&gps.accuracy_m>=0;
    if(fixed)locationLabel=Number.isFinite(gps.accuracy_m)?`Phone location · ±${Math.round(gps.accuracy_m)} m`:'Phone location saved';
    else if(gps.status==='denied')locationLabel='Location permission denied';
    else locationLabel=gps.status==='active'?'Phone location pending':'Phone location unavailable';
  }
  const duration=Number(incident.end_time)-Number(incident.start_time);
  const supplied=incidentLocation({record:{reviewer_location:record.reviewer_location}});
  if(supplied)locationLabel=`${supplied.label} · approximate`;
  return {
    title:showAssessment?modelTitle:labelVisible?label.title.trim():'Saved video for review',
    description:showAssessment?(sentence.length>150?assessment.text:remaining||'AI pre-analysis. Review the original footage before deciding.'):labelVisible&&typeof label.description==='string'?label.description:'Review the preserved original footage and its context.',
    assessmentSource:showAssessment?assessment.source:null,assessmentText:assessment?.text||null,
    reviewed,labelVisible,tags,requiresReview:requiresReview(incident),deleted:record.queue_deleted?.active===true,
    manual,initialObservation,
    held:record.retention_hold?.active===true,locationLabel,
    reviewStatus:({pending:'Pending human review',confirmed:'Flagged for follow-up',dismissed:'Dismissed',needs_review:'Needs more context'})[incident.review_status]||'Pending human review',
    duration:Number.isFinite(duration)&&duration>=0?duration:null,
    lighting:typeof record.lighting_condition==='string'?record.lighting_condition.replaceAll('_',' '):null,
    mediaUnavailable:record.expired===true||record.media_evicted===true&&!record.files?.thumbnail,
  };
}

export function updateIncidentQueue(incidents,incident){
  const remaining=incidents.filter(item=>item.id!==incident.id);
  return incident.record?.queue_deleted?.active===true?remaining:[incident,...remaining].sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')));
}
