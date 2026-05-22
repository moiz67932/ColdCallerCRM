# Hetzner Agent Refresh Commands

This project does not create a new demo agent for every client. It reuses one shared demo agent and one demo phone number, then switches the Supabase rows that the deployed runtime reads.

Shared agent:

```text
agent-87112821-4661-4dd9-a22e-ba57b48feb17
```

Agent DB id:

```text
87112821-4661-4dd9-a22e-ba57b48feb17
```

Demo number:

```text
+13103318914
```

## What Actually Changes

There are two different workflows:

1. If you are only switching the shared demo agent to a different clinic/database, update the Supabase rows and runtime config. That is a data/config change, not a Hetzner code deployment.
2. If you changed the agent code itself in this repo, use the redeploy flow below so Hetzner receives the updated runtime bundle.

## Current CRM Behavior

The CRM no longer exposes per-lead demo activation. The inbound demo number remains connected to the same shared Portive Clinic agent, and Automations only prepares website-derived lead profile data for review and future use.

## Normal Command: Redeploy Shared Agent Code

Run this when you changed the agent runtime code and need the already-published Hetzner agent to receive the updated files:

```bash
.venv/Scripts/python.exe scripts/redeploy_agent.py --agent-id agent-87112821-4661-4dd9-a22e-ba57b48feb17
```

If you are running the platform API on another URL, set it first:

```bash
export PLATFORM_BASE_URL="http://127.0.0.1:8000"
.venv/Scripts/python.exe scripts/redeploy_agent.py --agent-id agent-87112821-4661-4dd9-a22e-ba57b48feb17
```

The redeploy command calls the platform API endpoint:

```bash
POST /api/agents/{agent_id}/redeploy
```

Inside the platform, that flow does this:

```text
server_manager.redeploy_agent()
  -> _deploy_runtime()
  -> upload the current runtime bundle from this repo over SSH
  -> refresh the remote .env
  -> write supervisor/nginx configs
  -> install requirements.txt on the remote host
  -> restart the worker and webhook processes
  -> wait for /health to return 200
```

So the code update path is SSH-based runtime sync, not `git pull` on Hetzner and not `docker compose up` for the live agent.

## What Gets Changed In Supabase

When you intentionally update the shared demo agent runtime data outside the CRM, these are the relevant runtime tables:

```text
clinics
agent_settings
clinic_hours
knowledge_articles
agents.clinic_id
phone_numbers.clinic_id
phone_numbers.agent_id
```

The important idea: the single deployed agent stays the same, but its `clinic_id`, knowledge, greeting, services, hours, and phone mapping are switched to the selected client.

## When Docker Redeploy Is Needed

Do not use Docker Compose just to switch demo clients or refresh the shared agent code.

Only use Docker deployment commands when the actual Hetzner service image or the separate platform container stack changed.

To inspect what is running:

```bash
ssh root@178.104.70.97
docker ps
docker images
docker compose ls
```

If you are maintaining the separate Dockerized platform stack, update it with the compose file used on the server:

```bash
ssh root@178.104.70.97
cd /path/to/agent/deploy
docker compose pull
docker compose up -d
docker compose logs -f --tail=100
```

If it is a single Docker container, inspect the current image first:

```bash
ssh root@178.104.70.97
docker ps
docker inspect CONTAINER_NAME_OR_ID --format '{{.Config.Image}}'
```

Then redeploy using the same image/ports/env strategy already used on the server. Do not remove the running container until you know the exact replacement command.

## Verify Runtime Refresh

Check the deploy API is reachable:

```bash
curl -i "http://178.104.70.97:8001"
```

Redeploy the shared agent code:

```bash
.venv/Scripts/python.exe scripts/redeploy_agent.py --agent-id agent-87112821-4661-4dd9-a22e-ba57b48feb17
```

Then call the demo number and confirm it answers using the updated runtime or the newly selected client database.

## Common Failures

If a shared-agent redeploy or runtime refresh returns a stale-config warning, the Supabase write succeeded but the Hetzner publish refresh did not confirm.

Check:

```text
DEPLOY_API_URL=http://178.104.70.97:8001
DEPLOY_API_KEY=<bearer token, not an SSH key path>
EXISTING_DEMO_AGENT_DB_ID=87112821-4661-4dd9-a22e-ba57b48feb17
DEMO_TELNYX_PHONE_E164=+13103318914
```

If the phone answers the wrong client after a database-only switch, refresh the CRM/runtime config path first. If it still answers stale data after a code redeploy, inspect the Hetzner agent logs and the remote `.env` because the runtime may still be pointing at the wrong Supabase project or clinic record.
