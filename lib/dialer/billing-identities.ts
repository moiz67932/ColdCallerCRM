// CDR products use different identity columns. Match exact provider identifiers,
// never telephone numbers or approximate timestamps.
export function cdrIdentities(r:Record<string,unknown>):string[]{
 const ids:string[]=[];
 for(const [prefix,fields] of Object.entries({control:['call_control_id','telnyx_call_control_id'],leg:['call_leg_id','telnyx_leg_id'],session:['call_session_id','telnyx_session_id'],browserCall:['call_id'],browserSession:['session_id']}))
  for(const field of fields)if(typeof r[field]==='string'&&r[field])ids.push(`${prefix}:${r[field]}`);
 return ids;
}
export function matchCdr(r:Record<string,unknown>,index:Map<string,Set<string>>):string|null{
 const matches=new Set(cdrIdentities(r).flatMap(id=>[...(index.get(id)??[])]));
 return matches.size===1?[...matches][0]:null;
}
