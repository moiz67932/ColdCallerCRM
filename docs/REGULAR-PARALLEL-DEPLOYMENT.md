# Regular Parallel deployment

Regular Start/Resume does not read `dialer_provider_verifications` or require an
acceptance grant. Diagnostics remain optional. Do not insert fabricated reports.

## Production handoff

Production SQL execution was excluded at the owner's request. Do not enable the
new application against the old scheduler. No live call is needed for deployment.

1. Confirm there are no active sessions/attempts or pending/executing/uncertain
   commands. Preserve all existing ledgers and Durable Object state.
2. In Supabase SQL Editor, run the entire file
   `supabase/migrations/202611160001_regular_parallel.sql`. Alternatively:

   ```bash
   read -rsp 'Production PostgreSQL URL: ' PORTIVE_PRODUCTION_DATABASE_URL
   export PORTIVE_PRODUCTION_DATABASE_URL
   psql "$PORTIVE_PRODUCTION_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
     -f supabase/migrations/202611160001_regular_parallel.sql
   unset PORTIVE_PRODUCTION_DATABASE_URL
   ```

   Use the connection string from Supabase Project > Connect, including its
   password and SSL parameters. Never commit it. The local DATABASE_URL is not
   the production database. Do not reapply earlier migrations.

3. Configure the real calling business name as `DIALER_CALLER_NAME` in Vercel
   Production and Cloudflare Production. It identifies the caller in the spoken
   answered-collision explanation. Use the actual seller's identity.
4. Set Vercel Production `DIALER_RATE_CEILING_CENTS` to the verified, all-inclusive
   integer USD cents/minute ceiling, rounded up. This is a cost input, not a test
   certification. Include operator media, prospect Voice API, AMD, minimums and
   other fees. Do not guess it. Session credit and capacity are read live at
   Start/Resume; session budget is reserved conservatively in SQL.
5. Configure the applicable campaign/destination calling policies below.
6. Merge the tested feature branch into main without force-pushing. Deploy Vercel
   from that exact main SHA and deploy the existing Worker:

   ```bash
   cd /home/moiz/ColdCallerCRM
   git fetch origin
   git switch main
   git merge --ff-only origin/main
   git merge --ff-only feat/regular-parallel
   git push origin main
   cd /home/moiz/ColdCallerCRM/cloudflare/portive-dialer
   node node_modules/wrangler/bin/wrangler.js secret put DIALER_CALLER_NAME --env production
   node node_modules/wrangler/bin/wrangler.js deploy --env production --keep-vars
   ```

   Enter the business name at the secret prompt. Keep secrets, bindings, existing
   migrations and the five-minute schedule. No acceptance flags/grants are needed.
   If Vercel authentication expires, run `npx vercel login` and complete the login
   before checking its Production deployment. A failed API read is not Ready evidence.

7. Set Vercel Production `DIALER_PARALLEL_ENABLED=true`,
   `DIALER_CLOUDFLARE_ENABLED=true`, `DIALER_ORCHESTRATION_BACKEND=cloudflare` and
   redeploy the same main commit. Set Cloudflare `DIALER_PARALLEL_ENABLED=true`
   in its production Wrangler vars and deploy with `--keep-vars`. Keep
   `DIALER_ACCEPTANCE_ENABLED` absent/false.
8. Non-calling checks: authenticated `/internal/inspect` reports Parallel true,
   the matching configuration fingerprint and the same caller name; authenticated
   `/api/dial-sessions` reports Parallel available without any report. Run:

   ```sql
   select public.portive_regular_parallel_status();
   ```

   Expected: schemaVersion `202611160001`, reportRequired false, all active and
   unsettled counts zero. Do not call the Start RPC to smoke-test production.

## Calling policy

The policy evaluator uses recipient-local IANA timezones (including DST), both
at selection and at final authorization. Manual/Power keep their existing policy.

The bundled rules are the federal residential 08:00–21:00 window, FL/MD/OK
08:00–20:00, and TX 09:00–21:00 (Sunday 12:00–21:00). End times are exclusive.
This is not a comprehensive state/local/industry legal database. Add all other
applicable constraints before using a campaign. Missing named jurisdiction rules
fail closed. Without a campaign policy or destination jurisdiction, dispatch
reports `calling_jurisdiction_missing`; list membership supplies no exception.

Administrators configure `dialer_calling_rules` and
`dialer_campaign_calling_policies` directly. Browser roles cannot modify them.
For a campaign, specify its actual `list_id`, applicable `jurisdictions` array,
`start_minute`/`end_minute`, ISO weekdays (Monday=1), and actual `legal_basis`.
Include `US` for residential/unknown numbers and all stricter state/local rules.
Per-lead `callingJurisdiction` or two-letter `state` additionally intersects a
destination rule. Never infer legal jurisdiction or number type from an area code.

```sql
-- TEMPLATE: replace every placeholder using the actual campaign's legal scope.
insert into public.dialer_campaign_calling_policies
 (list_id,classification,jurisdictions,start_minute,end_minute,days,legal_basis)
values
 ('ACTUAL_LIST_ID','consumer',array['US','ACTUAL_STATE_RULE'],480,1260,
  array[1,2,3,4,5,6,7],'ACTUAL_REVIEWED_LEGAL_BASIS');
```

For a genuinely B2B campaign, `classification='business_landline'` exempts only
exact independently classified numbers in `business_numbers` from the federal
residential window. Set the applicable business/campaign hours and jurisdiction
rules explicitly. Every other number retains residential protection. The engine
does not infer landline status from a business name or generic custom boolean.

Specific lawful invitations outside ordinary hours belong in
`dialer_calling_consents`: exact lead, list, normalized number, UTC start/end,
genuine consent reference, legal basis covering every applicable rule, and
revocation. These never bypass DNC, suppression, spend, media or list eligibility.

Sources:
- https://www.ftc.gov/business-guidance/resources/complying-telemarketing-sales-rule
- https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.616.html
- https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText?article=gcl&section=14-4502
- https://www.oklegislature.gov/OK_Statutes/CompleteTitles/os15.pdf
- https://statutes.capitol.texas.gov/Docs/BC/htm/BC.301.htm

## Runtime and limitations

Up to four prospects share one parked operator. The existing database winner
transaction, provider deduplication, Durable Object concurrency, media lease,
uncertainty ledger, Stop and saved-disposition workflow remain authoritative.
An answered losing human receives a caller-identifying explanation before
hangup; speak-ended triggers cleanup and an alarm deadline provides a fallback.
It remains counted as an abandoned/collision call. Speech delivery cannot be
guaranteed if the provider fails; inspect the genuine command/event ledger.

No software test proves preserved opening words or live answer-to-audio latency.
Those remain unmeasured until actual user-initiated calling. AMD plus network
bridge latency can clip speech; no claim of zero clipping is made.

This repository has one shared operator identity, controller fencing and a global
single-operator lock. It has no independent tenant identity model. These changes
preserve existing authorization and do not add or claim multi-tenant isolation.
