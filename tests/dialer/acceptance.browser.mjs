// Generated UI fixtures only. Never registers SIP or reaches a provider/database.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const baseURL=process.env.PORTIVE_TEST_URL??'http://127.0.0.1:3210';
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext({baseURL});
  const login=await context.request.post('/api/auth/login',{data:{password:'portive-local-test-only'}});assert.equal(login.status(),200);
  const page=await context.newPage(),writes=[],errors=[];
  const controller='11111111-1111-4111-8111-111111111111',grant='22222222-2222-4222-8222-222222222222';
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(c=>sessionStorage.setItem('portive-controller',c),controller);
  let authorized=true;
  await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url());let data;
    if(req.method()!=='GET'){writes.push(url.pathname);throw new Error('Page load must not create a session or issue a provider token');}
    if(url.pathname==='/api/settings')data={settings:{locations:[]},runtimeConfig:{telnyxManualDialFlow:'browser_first',telnyxWebrtcCredentialConfigured:false}};
    else if(url.pathname==='/api/leads')data={leads:[]};
    else if(url.pathname==='/api/dial-sessions'){
      assert.equal(url.searchParams.get('acceptanceGrantId'),grant);assert.equal(url.searchParams.get('controllerId'),controller);
      data={session:null,lists:[{id:'list',name:'Consenting fixture'}],capabilities:{parallel:false,acceptance:true,parallelBlockers:['Ordinary Parallel is disabled.']},acceptanceAuthorization:authorized?{id:grant,list_id:'list',time_zone:'America/Chicago',destinations:[{phone_number:'+12125550101',time_zone:'America/Chicago'}],max_spend_cents:50,expires_at:new Date(Date.now()+60000).toISOString()}:null};
    } else throw new Error(`Unexpected request: ${url.pathname}`);
    await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(`/queue?parallelAcceptance=${grant}`);
  await page.getByRole('button',{name:'Start approved acceptance batch'}).waitFor();
  await page.getByText(/Only \+12125550101/).waitFor();
  assert.equal(await page.getByLabel('Dial session lead list').isDisabled(),true);
  assert.equal(await page.getByLabel('Maximum lines',{exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Start approved acceptance batch'}).isDisabled(),true,'softphone and review remain required');
  assert.equal(await page.getByRole('button',{name:'Continue next batch'}).count(),0);
  assert.deepEqual(writes,[]);
  authorized=false;await page.reload();
  await page.getByRole('button',{name:'Parallel',exact:true}).click();
  await page.getByText('Ordinary Parallel is disabled.').waitFor();
  assert.equal(await page.getByRole('button',{name:'Start approved acceptance batch'}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Start Session',exact:true}).isDisabled(),true);
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  console.log('PASS: acceptance UI binds the reviewed authorization, locks scope, preserves softphone/review gates, rejects an unavailable grant and causes zero mutations on page load.');
  await context.close();
} finally {await browser.close();}
