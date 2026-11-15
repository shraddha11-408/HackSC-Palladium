export interface IncidentCardDisplay {
  title:string;description:string;reviewed:boolean;tags:string[];deleted:boolean;manual:boolean;initialObservation:string|null;
  held:boolean;locationLabel:string|null;labelVisible:boolean;assessmentSource:string|null;assessmentText:string|null;requiresReview:boolean;
  reviewStatus:string;duration:number|null;lighting:string|null;mediaUnavailable:boolean;
}
export function deriveIncidentCard(incident:Record<string,any>):IncidentCardDisplay;

export function updateIncidentQueue(incidents:Record<string,any>[],incident:Record<string,any>):Record<string,any>[];
