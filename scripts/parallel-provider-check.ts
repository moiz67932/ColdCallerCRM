import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Telnyx from "telnyx";
import { createClient } from "@supabase/supabase-js";
import { parallelFingerprint } from "../lib/dialer/parallel-fingerprint";
import { evidenceBlockers } from "../lib/dialer/parallel-policy";

// Read-only unless --report points to evidence from the authorized controlled test
// environment. This command does not dial, transfer or bridge telephone calls.
async function main() {
  const required = (name: string) => { const value=process.env[name]; if(!value) throw new Error(`Missing ${name}`); return value; };
  const connection=process.env.TELNYX_PARALLEL_CONNECTION_ID || required("TELNYX_CONNECTION_ID"), credential=required("TELNYX_TELEPHONY_CREDENTIAL_ID");
  const config={connection,credential,callerId:required("TELNYX_FROM_NUMBER"),webhook:`${required("APP_BASE_URL").replace(/\/$/,"")}/api/webhooks/telnyx/voice`,overflow:required("DIALER_OVERFLOW_DESTINATION"),failureAudio:required("DIALER_FAILURE_AUDIO_URL"),amd:"premium",deadlineMs:1000};
  const fingerprint=parallelFingerprint(config);
  const client=new Telnyx({apiKey:required("TELNYX_API_KEY"),maxRetries:0});
  const [application,browser]=await Promise.all([client.callControlApplications.retrieve(connection),client.telephonyCredentials.retrieve(credential)]);
  const profileId=application.data?.outbound?.outbound_voice_profile_id;
  if(!profileId || !browser.data?.sip_username) throw new Error("Provider application/profile or browser credential is unavailable");
  const profile=await client.outboundVoiceProfiles.retrieve(profileId);
  console.log(JSON.stringify({fingerprint,connection,profileId,connectionChannels:application.data?.outbound?.channel_limit,profileChannels:profile.data?.concurrent_call_limit,webhookMatches:application.data?.webhook_event_url===config.webhook},null,2));
  const reportIndex=process.argv.indexOf("--report");
  if(reportIndex<0) { console.log("Read-only check complete. Controlled audio/collision evidence is still required to enable Parallel Mode."); return; }
  const report=JSON.parse(readFileSync(process.argv[reportIndex+1],"utf8"));
  const blockers=evidenceBlockers(report);
  if(blockers.length) throw new Error(blockers.join(" "));
  if(report.config_fingerprint!==fingerprint || report.profile_id!==profileId) throw new Error("Controlled report does not match this provider configuration");
  const age=Date.now()-Date.parse(report.verified_at);
  if(!Number.isFinite(age)||age<0||age>86400000) throw new Error("Controlled report must be from the past 24 hours");
  const audio=await fetch(config.failureAudio,{signal:AbortSignal.timeout(5000)});
  if(!audio.ok || Number(audio.headers.get("content-length"))>1000000) throw new Error("Failure explanation audio is unavailable or too large");
  const bytes=await audio.arrayBuffer();
  if(bytes.byteLength>1000000 || createHash("sha256").update(Buffer.from(bytes)).digest("hex")!==report.failure_audio_sha256) throw new Error("Failure explanation audio differs from the controlled report");
  const channels=Number(report.account_channels), overflow=Number(report.overflow_slots), rate=Number(report.rate_ceiling_cents);
  if(!Number.isInteger(channels)||channels<9||!Number.isInteger(overflow)||overflow<3||!Number.isInteger(rate)||rate<1) throw new Error("Report lacks verified channel/overflow capacity or an all-inclusive rate ceiling");
  if(Number(report.peak_concurrent_legs)<9) throw new Error("Controlled report must prove the peak nine-leg configuration, including overflow transfers");
  if((application.data?.outbound?.channel_limit??0)<channels || (profile.data?.concurrent_call_limit??0)<channels || application.data?.webhook_event_url!==config.webhook) throw new Error("Live provider limits or webhook do not satisfy the report");
  const db=createClient(required("SUPABASE_URL"),required("SUPABASE_SERVICE_ROLE_KEY"));
  const {data,error}=await db.from("dialer_provider_verifications").insert({config_fingerprint:fingerprint,connection_id:connection,profile_id:profileId,account_channels:channels,overflow_slots:overflow,rate_ceiling_cents:rate,evidence:report,expires_at:new Date(Date.now()+7*86400000).toISOString()}).select("id").single();
  if(error) throw new Error(error.message);
  console.log(`Controlled verification installed: ${data.id}. Start/Resume still recheck the live provider profile.`);
}
void main().catch((error)=>{console.error(error instanceof Error?error.message:error);process.exitCode=1;});
