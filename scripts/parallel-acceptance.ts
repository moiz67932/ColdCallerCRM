import { readFileSync, writeFileSync } from 'node:fs';
import Telnyx from 'telnyx';
import { createClient } from '@supabase/supabase-js';
import { parallelFingerprint } from '../lib/dialer/parallel-fingerprint';
import { acceptanceGrantBlockers, type AcceptanceGrant } from '../lib/dialer/acceptance-policy';

// Never places calls or enables a feature flag. Issuance is a production database
// write and requires the separate, explicit approval of the bounded live run.
async function main() {
  const [action, input, output] = process.argv.slice(2);
  const required = (k:string) => { if (!process.env[k]) throw new Error(`Missing ${k}`); return process.env[k]!; };
  const db = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), { auth:{persistSession:false} });
  if (action === 'issue') {
    if (!process.argv.includes('--authorize') || !input) throw new Error('Issuance requires a reviewed manifest and --authorize after explicit run approval.');
    const manifest = JSON.parse(readFileSync(input,'utf8'));
    if (process.env.DIALER_ORCHESTRATION_BACKEND !== 'cloudflare' || process.env.DIALER_PARALLEL_ENABLED !== 'false') throw new Error('Cloudflare ownership and unrestricted Parallel disabled are required.');
    const c = new Telnyx({apiKey:required('TELNYX_API_KEY'),maxRetries:0});
    const connection=required('TELNYX_PARALLEL_CONNECTION_ID'), credential=required('TELNYX_TELEPHONY_CREDENTIAL_ID');
    const webhook=required('APP_BASE_URL').replace(/\/$/,'')+'/api/webhooks/telnyx/voice';
    if (!webhook.startsWith('https://') || process.env.TELNYX_SKIP_SIGNATURE_VERIFICATION==='true' || !process.env.TELNYX_PUBLIC_KEY) throw new Error('Verified HTTPS webhooks required.');
    const [app,operator,balance]=await Promise.all([c.callControlApplications.retrieve(connection),c.telephonyCredentials.retrieve(credential),c.balance.retrieve()]);
    const profileId=app.data?.outbound?.outbound_voice_profile_id;
    if (!profileId || !app.data?.active || app.data.webhook_event_url!==webhook || !operator.data?.sip_username || operator.data.expired ||
      (operator.data.expires_at && Date.parse(operator.data.expires_at)<=Date.now())) throw new Error('Application, webhook or operator credential unavailable.');
    const profile=await c.outboundVoiceProfiles.retrieve(profileId);
    if (!profile.data?.enabled || !Number.isInteger(app.data.outbound?.channel_limit) || Number(app.data.outbound?.channel_limit)<5 ||
      !Number.isInteger(profile.data.concurrent_call_limit) || Number(profile.data.concurrent_call_limit)<5 ||
      manifest.account_channels>Math.min(Number(app.data.outbound?.channel_limit),Number(profile.data.concurrent_call_limit))) throw new Error('Explicit five-leg provider limits required.');
    const credit=Number(balance.data?.available_credit);
    if (balance.data?.currency!=='USD' || !Number.isFinite(credit) || Math.floor(credit*100)<manifest.max_spend_cents ||
      (profile.data.daily_spend_limit_enabled && Number(profile.data.daily_spend_limit)*100<manifest.max_spend_cents)) throw new Error('Credit/daily limit cannot cover approved budget.');
    const fingerprint=parallelFingerprint({connection,credential,callerId:required('TELNYX_FROM_NUMBER'),webhook,amd:'premium',deadlineMs:1000,orchestrationBackend:'cloudflare'});
    const grant={...manifest,config_fingerprint:fingerprint,profile_id:profileId,operator_sip_uri:`sip:${operator.data.sip_username}@sip.telnyx.com`};
    const blockers=acceptanceGrantBlockers({...grant,expires_at:new Date(Date.now()+900000).toISOString(),revoked_at:null,consumed_session_id:null} as AcceptanceGrant,grant.controller_id,fingerprint);
    if(blockers.length)throw new Error(blockers.join(' '));
    const {data,error}=await db.rpc('portive_acceptance_issue',{p_manifest:grant});
    if(error)throw new Error(error.message);
    console.log(JSON.stringify({grantId:data,queuePath:`/queue?parallelAcceptance=${data}`,budgetCents:grant.max_spend_cents,expiresInMinutes:15,prospects:grant.destinations.length,normalParallelEnabled:false}));
    return;
  }
  if (action==='revoke') {
    if(!input||!process.argv.includes('--authorize'))throw new Error('Revoke requires grant ID and --authorize.');
    const {error}=await db.rpc('portive_acceptance_revoke',{p_grant:input});if(error)throw new Error(error.message);
    console.log('Authorization revoked. Reconcile provider terminal events; do not delete uncertain commands.');return;
  }
  if(action==='export' && input && output) {
    const {data:session,error}=await db.from('dial_sessions').select('*').eq('id',input).single();
    if(error||!session?.acceptance_grant_id)throw new Error('Restricted acceptance session not found.');
    const reads=await Promise.all([
      db.from('call_attempts').select('*').eq('dial_session_id',input),
      db.from('dial_commands').select('*').eq('session_id',input),
      db.from('dial_audit_events').select('*').eq('session_id',input),
      db.from('dialer_acceptance_grants').select('*').eq('id',session.acceptance_grant_id).single(),
    ]);
    for(const read of reads)if(read.error)throw new Error(read.error.message);
    const attempts=reads[0].data as Array<Record<string,unknown>>;
    const ids=[session.operator_call_control_id,...attempts.map(a=>a.telnyx_call_control_id)].filter(Boolean);
    const receipts=ids.length?await db.from('workstation_telnyx_webhook_events').select('event_id,event_type,received_at,signature_verified,payload_json,processed_at,processing_error')
      .eq('signature_verified',true).in('payload_json->data->payload->>call_control_id',ids):{data:[],error:null};
    if(receipts.error)throw new Error(receipts.error.message);
    // No scenario is auto-certified. Browser playing telemetry is explicitly an
    // indicator, not proof of audible two-way media or first-word preservation.
    const draft={suite:'portive-parallel-v1',passed:false,orchestration_backend:'cloudflare',config_fingerprint:session.parallel_options.fingerprint,
      profile_id:reads[3].data.profile_id,scenarios:{},exported_at:new Date().toISOString(),
      provider_call_ids:ids,session,attempts,commands:reads[1].data,audit:reads[2].data,authorization:reads[3].data,signed_provider_receipts:receipts.data,
      review_required:'Correlate actual provider IDs, five-leg overlap, browser audio capture, synchronized clocks and measured latency. No acceptance results are inferred.'};
    writeFileSync(output,JSON.stringify(draft,null,2),{mode:0o600,flag:'wx'});
    console.log('Uncertified evidence draft saved privately. This draft cannot pass the report importer.');return;
  }
  throw new Error('Usage: parallel-acceptance.ts issue MANIFEST --authorize | revoke GRANT --authorize | export SESSION NEW_OUTPUT_FILE');
}
void main().catch(error=>{console.error(error instanceof Error?error.message:'Acceptance operation failed');process.exitCode=1;});
