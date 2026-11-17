// A maximum conversation length is an upper bound. Near the session deadline a
// shorter provider hard cap is safe; a new call must still have >=30s available.
export function fundedProspectLimit(deadlineAt:string,maxCallSeconds:number,ringTimeout:number,now=Date.now()) {
 const left=Math.floor((Date.parse(deadlineAt)-now)/1000);
 const limit=Math.min(maxCallSeconds+15,left-ringTimeout-8);
 if(!Number.isFinite(limit)||limit<30)throw Error('Funded session deadline cannot cover another call');
 return limit;
}
