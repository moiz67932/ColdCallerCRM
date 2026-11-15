import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceGrantBlockers, type AcceptanceGrant} from '../../lib/dialer/acceptance-policy';
const g:AcceptanceGrant={id:'grant',controller_id:'controller',list_id:'list',time_zone:'America/Chicago',config_fingerprint:'fingerprint',profile_id:'profile',operator_sip_uri:'sip:fixture@sip.telnyx.com',destinations:[{lead_id:'lead',phone_number:'+12125550101',time_zone:'America/Chicago',consent_reference:'consent-123'}],account_channels:5,rate_ceiling_cents:1,max_spend_cents:50,remaining_daily_cents:100,expires_at:new Date(Date.now()+60000).toISOString(),revoked_at:null,consumed_session_id:null};
test('acceptance is bound to controller, configuration, consent, expiry and one use',()=>{
  assert.deepEqual(acceptanceGrantBlockers(g,'controller','fingerprint'),[]);
  for(const patch of [{controller_id:'other'},{config_fingerprint:'other'},{revoked_at:new Date().toISOString()},{consumed_session_id:'session'},{expires_at:'invalid'},{expires_at:new Date(0).toISOString()},{account_channels:4},{destinations:[]},{destinations:[{...g.destinations[0],phone_number:'+442071234567'}]}])assert(acceptanceGrantBlockers({...g,...patch},'controller','fingerprint').length>0);
});
test('acceptance budget reserves bounded operator plus prospects and cannot exceed two dollars',()=>{
  for(const patch of [{max_spend_cents:5},{max_spend_cents:201},{rate_ceiling_cents:NaN},{rate_ceiling_cents:1.1},{remaining_daily_cents:49}])assert(acceptanceGrantBlockers({...g,...patch},'controller','fingerprint').length>0);
  assert(acceptanceGrantBlockers({...g,rate_ceiling_cents:10},'controller','fingerprint').length>0);
});
