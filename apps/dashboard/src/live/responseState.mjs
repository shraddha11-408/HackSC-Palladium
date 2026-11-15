export function requiresReview(incident) {
  if(incident.record?.queue_deleted?.active||incident.review_status==='dismissed')return false;
  if(['needs_review','confirmed'].includes(incident.review_status))return true;
  return incident.review_status==='pending'&&incident.record?.trigger_origin!=='reviewer'&&['REVIEW_REQUIRED','HIGH_PRIORITY_REVIEW'].includes(incident.severity);
}

export function responseRequested(incident) {
  return !incident.record?.queue_deleted?.active&&['needs_review','confirmed'].includes(incident.review_status);
}

export function monthBefore(date) {
  const [year,month,day]=date.split('-').map(Number);
  const last=new Date(Date.UTC(year,month-1,0));
  return `${last.getUTCFullYear()}-${String(last.getUTCMonth()+1).padStart(2,'0')}-${String(Math.min(day,last.getUTCDate())).padStart(2,'0')}`;
}

// Illustrative positions drawn from real walk-network vertices. They are never
// presented as tracked officers, inferred people, or operational assignments.
export function demoResponders(bundle, target) {
  const nodes=bundle.graph.nodes;
  const points=Array.isArray(nodes)?(bundle.graph.largest_component||nodes.map((_,i)=>i)).map(i=>nodes[i]):Object.values(nodes);
  const candidates=points.map(node=>Array.isArray(node)?node:node.coordinates).filter(p=>Array.isArray(p)&&p.length>=2)
    .map(p=>({point:[p[0],p[1]],distance:Math.hypot((p[0]-target[0])*92300,(p[1]-target[1])*111320),angle:Math.atan2(p[1]-target[1],p[0]-target[0])}))
    .filter(p=>p.distance>=100&&p.distance<=500).sort((a,b)=>a.distance-b.distance);
  const chosen=[];
  const apart=p=>chosen.every(q=>Math.hypot((p.point[0]-q.point[0])*92300,(p.point[1]-q.point[1])*111320)>=75);
  for(let quadrant=0;quadrant<4;quadrant++){
    const angle=-Math.PI+(quadrant+.5)*Math.PI/2;
    const next=candidates.filter(p=>Math.floor((p.angle+Math.PI)/(Math.PI/2))%4===quadrant&&apart(p))
      .sort((a,b)=>(Math.abs(a.distance-220)+Math.abs(a.angle-angle)*120)-(Math.abs(b.distance-220)+Math.abs(b.angle-angle)*120))[0];
    if(next)chosen.push(next);
  }
  for(const p of candidates){if(chosen.length===4)break;if(!chosen.includes(p)&&apart(p))chosen.push(p);}
  return chosen.slice(0,4).map((p,i)=>({id:`demo-${i+1}`,name:`Demo responder ${i+1}`,role:i<2?'Ambassador':'DPS officer',point:p.point,distance:Math.round(p.distance)}));
}
