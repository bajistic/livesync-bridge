# LiveSync Bridge — Deployment Notes

This documents the setup bridging `~/clawd` (VPS filesystem) to Obsidian iOS via CouchDB and livesync-bridge.

## Architecture

```
~/clawd (VPS)  <-->  livesync-bridge  <-->  CouchDB (Docker)  <-->  Obsidian iOS
  (filesystem)       (Deno, Docker)        sync.bajistic.xyz        (LiveSync plugin)
```

- **livesync-bridge** watches `~/clawd` for file changes and syncs them into CouchDB
- **CouchDB** (`obsidian-couchdb` container) stores encrypted/obfuscated documents
- **Obsidian iOS** connects to CouchDB via `sync.bajistic.xyz` (nginx reverse proxy)
- Sync is **bidirectional** — edits on iOS or VPS propagate through CouchDB

## Credentials

- **CouchDB URL:** `http://localhost:5984` (internal), `https://sync.bajistic.xyz` (external)
- **Database:** `clawd`
- **Username:** `admin`
- **Password:** `YOUR_COUCHDB_PASSWORD`
- **E2EE Passphrase:** `YOUR_E2EE_PASSPHRASE`
- **Path Obfuscation:** enabled, same passphrase

## Config

Config file: `~/livesync-bridge/dat/config.json`

Key settings:
- `database`: `clawd` — the CouchDB database name
- `passphrase` + `obfuscatePassphrase`: must match Obsidian iOS LiveSync settings
- `useRemoteTweaks: true`: bridge reads chunk/encryption settings from CouchDB milestone doc
- `useChokidar: false`: uses Deno's native fs watcher (more reliable for initial scan)
- `baseDir` (storage peer): `/app/data/ivault/` — this is the **container-internal** path
  - The docker volume maps `~/clawd` -> `/app/data/ivault/` inside the container
  - Do NOT use the host path here

### Ignored paths (not synced to CouchDB/iOS)
```
.git, .trash, .obsidian/workspace, .obsidian/cache, node_modules,
venv, .venv, __pycache__, .pytest_cache, .mypy_cache, temp_conv,
.claude, discovery_cache, site-packages, .DS_Store, memory/monitoring
```

`memory/monitoring` is excluded because it contains frequently-changing log/state files
that would churn CouchDB for no value on mobile.

## Docker Setup

```bash
cd ~/livesync-bridge
docker compose up -d        # Start bridge
docker compose down          # Stop and remove container (clears localStorage state)
docker compose restart       # Restart (keeps localStorage state)
docker compose logs --tail 50  # Check logs
```

The CouchDB container is separate:
```bash
docker restart obsidian-couchdb  # Restart CouchDB
```

## Key Operational Knowledge

### Initial Sync / Full Rescan
The bridge stores scan state in Deno's localStorage inside the container. To force a full rescan:
```bash
cd ~/livesync-bridge
docker compose down    # Remove container (clears localStorage)
docker compose up -d   # Fresh container = full rescan
```

Do NOT just `docker compose restart` — that preserves the container and its localStorage.

### Throttling
A 2-second delay was added to `PeerStorage.ts` (line ~274) in the initial scan loop
to prevent overwhelming CouchDB during bulk uploads. Without this, 1000+ files
firing concurrently cause ETIMEDOUT errors and connection exhaustion.

### CouchDB Overload Signs
- `ETIMEDOUT` errors in bridge logs
- `503` responses from `sync.bajistic.xyz`
- CouchDB becomes unresponsive to `curl localhost:5984`

Recovery:
```bash
cd ~/livesync-bridge && docker compose stop   # Stop bridge first
docker restart obsidian-couchdb               # Restart CouchDB
# Wait for CouchDB to respond
curl http://admin:PASSWORD@localhost:5984/
cd ~/livesync-bridge && docker compose start   # Resume bridge
```

### CouchDB Maintenance
```bash
# Compact database (reduces disk usage from old revisions)
curl -X POST 'http://admin:PASSWORD@localhost:5984/clawd/_compact' -H 'Content-Type: application/json'

# Check database stats
curl 'http://admin:PASSWORD@localhost:5984/clawd'

# Count file docs vs chunks
curl 'http://admin:PASSWORD@localhost:5984/clawd/_all_docs' | python3 -c "
import sys,json; d=json.load(sys.stdin)
f=sum(1 for r in d['rows'] if r['id'].startswith('f:'))
h=sum(1 for r in d['rows'] if r['id'].startswith('h:'))
print(f'files: {f}, chunks: {h}, total: {d[\"total_rows\"]}')"
```

### Nginx Rate Limiting
Rate limiting on `sync.bajistic.xyz` was **disabled** because LiveSync replication
makes many rapid small requests. The default `10r/s burst=30` caused 503 errors
that broke replication and showed as "Failed to gather content" errors on iOS.

Config: `/etc/nginx/sites-available/sync.bajistic.xyz`

### Milestone Document
CouchDB stores a `_local/obsydian_livesync_milestone` document with:
- Accepted node IDs (one per bridge container instance + one per iOS device)
- `tweak_values`: encryption settings, chunk sizes, hash algorithm

Important: the bridge does NOT advertise `encrypt: true` or `usePathObfuscation: true`
in its tweak_values even when passphrases are configured. If you nuke and recreate the
database, you must manually update the milestone after the first sync:

```bash
# Fetch, update encrypt/obfuscation flags, and save back
curl -s 'http://admin:PASSWORD@localhost:5984/clawd/_local/obsydian_livesync_milestone' | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
for node_id in d['tweak_values']:
    d['tweak_values'][node_id]['encrypt'] = True
    d['tweak_values'][node_id]['usePathObfuscation'] = True
print(json.dumps(d))
" | curl -s -X PUT 'http://admin:PASSWORD@localhost:5984/clawd/_local/obsydian_livesync_milestone' \
  -H 'Content-Type: application/json' -d @-
```

### PBKDF2 Salt
The sync parameters doc at `_local/obsidian_livesync_sync_parameters` contains the
PBKDF2 salt used for E2EE key derivation. This is created automatically by the bridge
on first sync. If iOS shows "Failed to obtain PBKDF2 salt", it's usually a transient
503 error, not a missing document.

## Obsidian iOS Setup

LiveSync plugin settings:
- **Remote Type:** CouchDB
- **URI:** `https://sync.bajistic.xyz`
- **Username:** `admin`
- **Password:** `YOUR_COUCHDB_PASSWORD`
- **Database name:** `clawd`
- **End-to-End Encryption:** enabled
- **Passphrase:** `YOUR_E2EE_PASSPHRASE`
- **Path Obfuscation:** enabled (same passphrase)
- **Live Sync:** enabled (after initial fetch)

### First-time setup or after database rebuild
1. Configure the settings above
2. Go to **Rebuild everything** -> **Fetch rebuild from remote**
3. Wait for all files to sync (watch the counter)
4. Enable Live Sync from settings

### Troubleshooting iOS
- **"Failed to gather content"**: Usually missing chunks or decryption mismatch.
  Check that encrypt/obfuscation flags are set in the milestone document.
- **503 errors**: CouchDB overloaded or nginx rate limiting. Check nginx config.
- **"The string did not match the expected pattern"**: Usually a transient connection error.
- **Stale data after DB rebuild**: Delete local database on iOS first, then fetch rebuild.

## Complete Database Rebuild Procedure

If things are broken and you need to start fresh:

```bash
# 1. Stop the bridge
cd ~/livesync-bridge && docker compose down

# 2. Delete and recreate the CouchDB database
curl -X DELETE 'http://admin:YOUR_COUCHDB_PASSWORD@localhost:5984/clawd'
curl -X PUT 'http://admin:YOUR_COUCHDB_PASSWORD@localhost:5984/clawd'

# 3. Start bridge (fresh container = clean localStorage = full rescan)
docker compose up -d

# 4. Wait for initial sync to complete (~30-40 min for ~1000 files with 2s throttle)
# Monitor progress:
watch -n 30 'curl -s http://admin:YOUR_COUCHDB_PASSWORD@localhost:5984/clawd/_all_docs | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
  f=sum(1 for r in d[\"rows\"] if r[\"id\"].startswith(\"f:\")); \
  print(f\"file docs: {f} / total: {d[\\\"total_rows\\\"]}\")"'

# 5. Once scan completes, fix the milestone encryption flags
curl -s 'http://admin:YOUR_COUCHDB_PASSWORD@localhost:5984/clawd/_local/obsydian_livesync_milestone' | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
for node_id in d['tweak_values']:
    d['tweak_values'][node_id]['encrypt'] = True
    d['tweak_values'][node_id]['usePathObfuscation'] = True
print(json.dumps(d))
" | curl -s -X PUT 'http://admin:YOUR_COUCHDB_PASSWORD@localhost:5984/clawd/_local/obsydian_livesync_milestone' \
  -H 'Content-Type: application/json' -d @-

# 6. Compact the database
curl -X POST 'http://admin:YOUR_COUCHDB_PASSWORD@localhost:5984/clawd/_compact' \
  -H 'Content-Type: application/json'

# 7. On Obsidian iOS:
#    - Delete local database (Settings > LiveSync > Rebuild > Delete local database)
#    - Configure settings (URI, credentials, passphrase, obfuscation)
#    - Fetch rebuild from remote
#    - Wait for all files, then enable Live Sync
```

**Critical**: Do NOT touch CouchDB or restart the bridge during initial sync.
Each interruption loses files that then require another full rescan pass.

## CouchDB Container Setup

The CouchDB container is managed separately from the bridge (not in the same docker-compose).

```bash
# Container name: obsidian-couchdb
# Image: couchdb:3.4
# Port: 127.0.0.1:5984 (localhost only, nginx proxies external access)

# Check status
docker ps | grep couchdb

# Restart
docker restart obsidian-couchdb

# Logs
docker logs obsidian-couchdb --tail 50
```

CouchDB tuning applied:
```bash
# Increase connection limits (default was too low)
curl -X PUT 'http://admin:PASSWORD@localhost:5984/_node/_local/_config/httpd/max_connections' -d '"2048"'
curl -X PUT 'http://admin:PASSWORD@localhost:5984/_node/_local/_config/couchdb/max_document_size' -d '"67108864"'
```

## Migration History

**2026-03-15**: Migrated from `~/vaults/ivault/clawd` (symlink) to `~/clawd` (real directory)
as the Obsidian vault root. This required:
- Updating the docker-compose volume mount
- Recreating the bridge container (old mount was stale)
- Fixing `baseDir` in config (must be container-internal path `/app/data/ivault/`)
- Setting `obfuscatePassphrase` (was empty, causing bridge crash)
- Switching from `useChokidar: true` to `false` (chokidar overwhelmed CouchDB)
- Adding 2s throttle to initial scan
- Disabling nginx rate limiting on sync.bajistic.xyz
- Manually setting encrypt/obfuscation flags in CouchDB milestone
- Renaming database from `ivault` to `clawd`

## Lessons Learned (2026-03-15 migration)

1. **Volume mounts are snapshot-in-time** — if you change the host path (e.g., from symlink
   to real directory), you must `docker compose down && up` to recreate the container.
   `docker compose restart` reuses the old mount.

2. **Deno localStorage persists in the container** — the bridge tracks which files
   it has scanned. To force a rescan, you must recreate the container, not just restart.

3. **CouchDB can't handle 1000+ concurrent writes** — the bridge's chokidar watcher
   fires all files simultaneously on startup. Switch to `useChokidar: false` (Deno watcher)
   which processes files sequentially, and add a delay between uploads.

4. **nginx rate limiting kills LiveSync** — CouchDB replication protocol makes many
   small rapid requests. Even `10r/s burst=30` is too low. Disable rate limiting on
   the sync subdomain.

5. **The bridge doesn't set encrypt/obfuscation flags in tweak_values** — even when
   passphrases are configured, the milestone advertises `encrypt: false`. This causes
   Obsidian iOS to try reading encrypted data as plaintext. Fix manually after DB creation.

6. **Multiple bridge container restarts = multiple node IDs** — each `docker compose down && up`
   creates a new node in the milestone. This is generally fine but avoid excessive restarts
   during initial sync as it fragments the scan state.
