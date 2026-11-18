// Generated fixtures only; every API except local login is intercepted.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import budget from '../../lib/dialer/budget.ts';
const {budgetQuote}=budget;
const browser=await chromium.launch({headless:true});
try{
 const context=await browser.newContext({baseURL:process.env.PORTIVE_TEST_URL??'http://127.0.0.1:3210'});
 assert.equal((await context.request.post('/api/auth/login',{data:{password:'portive-local-test-only'}})).status(),200);
 const page=await context.newPage(),errors=[],writes=[];let requests=0,opensAt=0;
 page.on('pageerror',e=>errors.push(e.message));
 const profile={sipPerMinuteMicros:5000,operatorSipPerMinuteMicros:2000,callControlPerMinuteMicros:2000,webrtcPerMinuteMicros:2000,bridgePerMinuteMicros:0,recordingPerMinuteMicros:2000,otherPerMinuteMicros:0,amdPerCallMicros:6500,ttsPerCharacterMicros:9,operatorFixedMicros:0,prospectFixedMicros:0,minimumSeconds:60,incrementSeconds:60};
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url());assert.equal(req.method(),'GET','Preflight must not mutate production');let result;
  if(url.pathname==='/api/settings')result={settings:{locations:[]},runtimeConfig:{telnyxManualDialFlow:'browser_first',telnyxWebrtcCredentialConfigured:false}};
  else if(url.pathname==='/api/leads')result={leads:[]};
  else if(url.pathname==='/api/dial-sessions')result={session:null,lists:[{id:'list',name:'Colorado fixture'}],capabilities:{parallel:true,parallelBlockers:[]}};
  else if(url.pathname==='/api/dial-sessions/quote'){
   requests++;if(!opensAt)opensAt=Date.now()+1000;
   const o={...Object.fromEntries([...url.searchParams].map(([k,v])=>[k,Number(v)])),answerPolicy:url.searchParams.get('answerPolicy')};
   const q=budgetQuote(profile,o,o.lines),eligible=Date.now()>=opensAt?4:0;
   result={quote:q,presets:[],authorizedCents:100,shortfallCents:0,availableCreditCents:402,dailyHeadroomCents:200,heldCreditCents:190,dailyHeldCents:66,pricingSource:'Synthetic browser fixture only',capacity:{totalChannels:10,availableChannels:10,verification:'manual',confirmedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()},blockers:[],eligibility:{eligible,reasons:eligible?{}:{outside_calling_window:4}},nextWindow:{at:new Date(opensAt).toISOString(),timeZone:'America/Denver'},billing:null};
  }else throw Error('Unexpected fixture request '+url.pathname);
  await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
 });
 await page.goto('/queue');await page.getByRole('button',{name:'Parallel',exact:true}).click();
 const panel=page.getByLabel('Parallel cost preflight');await panel.getByText(/Maximum initial exposure/).waitFor();
 await panel.getByText(/Next recipient-local policy window/).waitFor();
 await panel.getByText(/Currently eligible: 4/).waitFor();assert(requests>=2,'Opening the actual allowed window must refresh eligibility automatically');
 await page.getByRole('button',{name:'5-minute conversation',exact:true}).click();
 await panel.getByText(/Maximum initial exposure:.*\$0.36/).waitFor();
 assert.equal(await page.getByLabel('Session hard limit',{exact:true}).inputValue(),'900','Conversation presets must preserve the list session duration');
 await panel.getByText(/Unsettled reserves: \$1.90 against credit; \$0.66 against today/).waitFor();
 assert.equal(await page.getByRole('button',{name:'Start Session',exact:true}).isDisabled(),true,'A quote never substitutes for operator readiness and list review');
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 console.log('PASS: component-priced exposure, five-minute preset, recipient-local next window, automatic eligibility refresh, operator/review gates and zero mutations.');
 await context.close();
}finally{await browser.close();}
