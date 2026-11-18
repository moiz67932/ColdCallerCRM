// UI-only transport/provider fixtures. This test never calls a telephone number.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const baseURL=process.env.PORTIVE_TEST_URL ?? "http://127.0.0.1:3210";
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({baseURL});
try {
  const login=await context.request.post("/api/auth/login",{data:{password:"portive-local-test-only"}}); assert.equal(login.status(),200);
  const controller="11111111-1111-4111-8111-111111111111";
  let session={id:"parallel",controller_id:controller,selected_list_id:"list",mode:"parallel",max_lines:4,status:"running",phase:"calling",active_call_id:null,heartbeat_at:new Date().toISOString(),reason:null,operator_leg_state:"ready"};
  const leads=["Sunset Aesthetics","Pure Glow Med Spa","Bella Injectables","Nova Skin Studio"].map((businessName,index)=>({
    id:`lead-${index}`,leadListId:"list",businessName,phoneNumber:`+1212555010${index+1}`,createdAt:new Date().toISOString(),notes:`Notes for ${businessName}`,tags:[],followUps:[],callAttempts:[],leadList:{name:"Controlled list",sourceFileName:"fixture.csv"},
  }));
  let attempts=leads.map((lead,index)=>({id:`attempt-${index}`,lead_id:lead.id,status:"dialing",technical_state:"ringing",answer_classification:"unknown",started_at:new Date().toISOString(),ringing_at:new Date().toISOString(),ended_at:null,outcome:null,parallel_batch:1,was_bridged_to_operator:false,overflow_state:null,leads:{business_name:lead.businessName,phone_number:lead.phoneNumber,lead_lists:{name:"Controlled list"}}}));
  const writes=[];const errors=[];let historyUrl="";
  const page=await context.newPage();page.on("pageerror",error=>errors.push(error.message));
  await page.addInitScript(({controller})=>{
    sessionStorage.setItem("portive-controller",controller);
    window.EventSource=class extends EventTarget {
      constructor() {super(); window.__emitParallel=(data)=>this.dispatchEvent(new MessageEvent("snapshot",{data:JSON.stringify(data)}));}
      close() {}
    };
  },{controller});
  await page.route("**/api/**",async(route)=>{
    const request=route.request(),path=new URL(request.url()).pathname;let result;
    if(path==="/api/settings") result={settings:{locations:[]},runtimeConfig:{telnyxManualDialFlow:"browser_first",telnyxWebrtcCredentialConfigured:true}};
    else if(path==="/api/dial-sessions") {
      if(request.method()==="POST") { const data=request.postDataJSON();writes.push({path,...data}); if(data.action==="stop") session={...session,status:"stopping"};if(["continue","skip"].includes(data.action))session={...session,phase:"calling",active_call_id:null,parallel_batch:(session.parallel_batch??1)+1};result={session,dispatch:false}; }
      else result={session,lists:[{id:"list",name:"Controlled list"}],capabilities:{parallel:true,parallelBlockers:[]}};
    } else if(path==="/api/dial-sessions/quote") result={quote:null,presets:[],blockers:[],eligibility:{eligible:4,reasons:{}},nextWindow:null,billing:null,capacity:{availableChannels:10,totalChannels:10,confirmedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()},authorizedCents:100};
    else if(path==="/api/leads") result={leads};
    else if(path==="/api/calls") {historyUrl=request.url();result={calls:[{id:"attempt-0",status:"canceled",technicalState:"canceled_after_winner",outcome:null,createdAt:new Date().toISOString(),lead:{id:"lead-0",businessName:leads[0].businessName,phoneNumber:leads[0].phoneNumber,niche:"Aesthetics",leadList:{id:"list",name:"Controlled list"}}}]};}
    else if(/^\/api\/calls\//.test(path)) {
      const attempt=attempts.find(item=>item.id===path.split("/").pop());result={callAttempt:{...attempt,leadId:attempt.lead_id,rawSummaryJson:{progressState:attempt.was_bridged_to_operator?"bridged":"lead_ringing"}}};
      if(request.method()!=="GET") writes.push({path,...request.postDataJSON()});
    } else if(/\/notes$|\/followups$|\/outcome$/.test(path)) {writes.push({path,...request.postDataJSON()});result={saved:true};}
    else if(/^\/api\/leads\//.test(path)) {
      const lead=leads.find(item=>item.id===path.split("/").pop());const attempt=attempts.find(item=>item.lead_id===lead.id);
      result={lead:{...lead,callAttempts:[{id:attempt.id,status:attempt.status,answeredAt:attempt.was_bridged_to_operator?attempt.started_at:null,endedAt:attempt.ended_at,rawSummaryJson:{progressState:attempt.was_bridged_to_operator?"bridged":"lead_ringing"}}]}};
    } else throw new Error(`Unexpected API request: ${path}`);
    await route.fulfill({contentType:"application/json",body:JSON.stringify(result)});
  });
  await page.goto("/queue");await page.getByRole("button",{name:"Stop Session",exact:true}).waitFor();
  const emit=async()=>page.evaluate(data=>window.__emitParallel(data),{session,attempts,metrics:{total_dials:4,human_connections:0}});
  await emit(); await page.getByLabel("Parallel live calls").waitFor();
  assert.equal(await page.locator("[data-attempt-id]").count(),4);
  session={...session,active_call_id:"attempt-2",operator_leg_state:"bridged"};
  attempts=attempts.map((item,index)=>index===2?{...item,status:"connected",technical_state:"connected_to_operator",answer_classification:"human",was_bridged_to_operator:true}:item);
  await emit(); await page.locator('[data-attempt-id="attempt-2"]').getByText(/Connected to Operator/).waitFor();
  await page.waitForFunction(()=>document.querySelector("#notes-box")?.value==="Notes for Bella Injectables");
  await page.locator("#notes-box").fill("Manager Sara will call back");await page.getByRole("button",{name:"Save note",exact:true}).click();
  assert(writes.some(item=>item.path==="/api/leads/lead-2/notes"&&item.callAttemptId==="attempt-2"));
  await page.getByRole("button",{name:"Tomorrow morning",exact:true}).click();
  await page.getByText(/Callback reminder saved/).waitFor();
  assert(writes.some(item=>item.path==="/api/leads/lead-2/followups"&&item.callAttemptId==="attempt-2"));
  session={...session,phase:"awaiting_disposition",operator_leg_state:"ready"};
  attempts=attempts.map(item=>item.id==="attempt-2"?{...item,status:"completed",ended_at:new Date().toISOString()}:item);
  await emit();
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Continue next batch'&&!b.disabled));
  await page.getByRole("button",{name:"Continue next batch",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[role="status"]')?.textContent?.includes('calling'));
  assert(writes.some(item=>item.action==="continue"&&item.sessionId==="parallel"&&item.controllerId===controller));
  assert.equal(await page.getByRole("button",{name:"Continue next batch",exact:true}).isDisabled(),true);
  session={...session,phase:"awaiting_disposition",active_call_id:"attempt-2"};await emit();
  await page.getByRole("button",{name:"Skip Lead",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[role="status"]')?.textContent?.includes('calling'));
  assert(writes.some(item=>item.action==="skip"&&item.sessionId==="parallel"));
  session={...session,active_call_id:"attempt-2",operator_leg_state:"bridged"};
  attempts=attempts.map(item=>item.id==="attempt-2"?{...item,status:"connected",ended_at:null}:item);await emit();
  await page.getByRole("button",{name:"Stop Session",exact:true}).click();
  assert(writes.some(item=>item.action==="stop"));
  assert(!writes.some(item=>item.path==="/api/calls/attempt-2"));
  session={...session,status:"stopped",phase:"ready",ended_at:new Date().toISOString(),operator_leg_state:"disconnected"};await emit();
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Stop Session'&&b.disabled));
  assert.equal(await page.getByRole("button",{name:"Continue next batch",exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole("button",{name:"Skip Lead",exact:true}).isDisabled(),true);
  await page.goto("/history");
  await page.getByRole("combobox").nth(0).click();
  await page.getByRole("option",{name:"Canceled After Winner"}).click();
  await page.getByRole("link",{name:"Sunset Aesthetics"}).waitFor();
  assert(historyUrl.includes("technicalState=canceled_after_winner"));
  assert.equal(await page.getByRole("link",{name:"Sunset Aesthetics"}).getAttribute("href"),"/queue?leadId=lead-0");
  assert.deepEqual(errors,[]);
  await page.screenshot({path:"/tmp/portive-parallel-cards.png",fullPage:true});
  console.log("PASS: four SSE-fed cards; winner focus, notes and callback use its lead ID; Continue and Skip send the owned session commands; continuation disables during calling; Stop requests session cleanup without directly hanging up the prospect; terminal Stop/Continue/Skip are disabled; history links to the lead; zero page errors. No real telephony tested.");
} finally {await context.close();await browser.close();}
