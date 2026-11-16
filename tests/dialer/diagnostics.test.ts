import assert from 'node:assert/strict';
import test from 'node:test';
import {safeDiagnostic} from '../../lib/dialer/diagnostics';
test('diagnostics preserve SQL operation errors and safe codes without credentials',()=>{
 const error=Object.assign(new Error('permission denied for table dialer_cost_holds'),{code:'42501',status:403});
 assert.deepEqual(safeDiagnostic(error),{name:'Error',message:error.message,code:'42501',status:403});
 const secret='real-fixture-private-value';
 const d=safeDiagnostic(Object.assign(new Error(`Failed ${secret} Bearer abcdef api_key=private token=hidden eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signature +12125550101`),{code:'unsafe value'}),[secret]);
 for(const value of [secret,'abcdef','private token','hidden','eyJhbG','+12125550101'])assert(!d.message.includes(value));
 assert.equal(d.code,undefined);
});
