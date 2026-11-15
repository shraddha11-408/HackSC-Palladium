type Data=Record<string,any>;
export function requiresReview(incident:Data):boolean;
export function responseRequested(incident:Data):boolean;
export function monthBefore(date:string):string;
export function demoResponders(bundle:Data,target:[number,number]):{id:string;name:string;role:string;point:[number,number];distance:number}[];
