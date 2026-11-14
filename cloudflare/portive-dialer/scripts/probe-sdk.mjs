// Offline SDK compatibility probe: its fetch is replaced inside the runtime.
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
let mf;
try {
const result=await build({stdin:{contents:`import Telnyx from 'telnyx';export default {async fetch(){const api=new Telnyx({apiKey:'offline-fixture',maxRetries:0,fetch:async()=>Response.json({data:{call_control_id:'fixture'}})});const r=await api.calls.dial({connection_id:'fixture',from:'+12125550100',to:'+12125550101'});return Response.json({sdk:r.data.call_control_id});}}`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'neutral',mainFields:['browser','module','main'],external:['node:*'],conditions:['workerd','browser'],logLevel:'silent'});
mf=new Miniflare({modules:true,script:result.outputFiles[0].text,compatibilityDate:'2026-11-14'});const response=await mf.dispatchFetch('https://offline.example');console.log(JSON.stringify({sdk:'telnyx@6.41.0',nodeCompatibility:false,bundleBytes:result.outputFiles[0].text.length,result:await response.json(),realProviderRequests:0}));}
catch(error){console.log(JSON.stringify({sdk:'telnyx@6.41.0',nodeCompatibility:false,compatible:false,error:String(error).slice(0,500),realProviderRequests:0}));}
finally {if(mf)await mf.dispose();}
