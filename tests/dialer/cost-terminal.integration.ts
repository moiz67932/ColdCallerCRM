import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

test('service_role terminal triggers update private holds without granting ledger writes',()=>{
 const container='portive-dialer-test-20261113',database=`terminal_privileges_${process.pid}`;
 const sql=(input:string,db=database)=>execFileSync('docker',['exec','-i',container,'psql','-X','-qAt','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],{input,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 sql(`create database ${database}`,'postgres');
 try {
  sql(`create table dial_sessions(id text primary key,operator_terminal_at timestamptz,parallel_options jsonb);
   create table call_attempts(id text primary key,dial_session_id text,ended_at timestamptz);
   create table dialer_cost_holds(id text primary key,session_id text,attempt_id text,role text,cap_cents integer,terminal_at timestamptz);
   alter table dialer_cost_holds enable row level security;
   grant usage on schema public to service_role;
   grant select,update on dial_sessions,call_attempts to service_role;
   grant select on dialer_cost_holds to service_role;
   insert into dial_sessions values('session',null,null);
   insert into call_attempts values('attempt','session',null);
   insert into dialer_cost_holds values('session:operator','session',null,'operator',12,null),('attempt','session','attempt','prospect',9,null);`);
  const original=readFileSync('supabase/migrations/202611160003_parallel_exposure_budget.sql','utf8');
  for(const name of ['portive_cost_terminal','portive_create_cost_hold'])sql(original.match(new RegExp(`create or replace function public\\.${name}\\(\\)[\\s\\S]*?end \\$\\$;`))![0]);
  sql(`create trigger operator_terminal after update of operator_terminal_at on dial_sessions for each row execute function portive_cost_terminal();
   create trigger prospect_terminal after update of ended_at on call_attempts for each row execute function portive_cost_terminal();`);
  assert.throws(()=>sql("set role service_role;update dial_sessions set operator_terminal_at=now() where id='session';"),/permission denied for table dialer_cost_holds/);
  sql(readFileSync('supabase/migrations/202611160005_cost_terminal_privileges.sql','utf8'));
  sql("set role service_role;update dial_sessions set operator_terminal_at=now() where id='session';update call_attempts set ended_at=now() where id='attempt';");
  assert.equal(sql('select count(*) from dialer_cost_holds where terminal_at is not null'),'2');
  assert.throws(()=>sql("set role service_role;update dialer_cost_holds set cap_cents=0;"),/permission denied/);
  assert.equal(sql("select sum(cap_cents) from dialer_cost_holds"),'21');
 } finally {sql(`drop database ${database}`,'postgres');}
});
