# FieldSync

Offline-first Progressive Web App (PWA) for environmental field researchers. FieldSync stores observations, photos, and GPS tracks locally in IndexedDB (via Dexie.js) and syncs automatically with a FastAPI + SQLite backend using Hybrid Logical Clocks (HLC) and field-level last-write-wins merging.

See [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) for the data model, HLC format, merge rules, and API contract.

---

## 1. Running Locally

### Prerequisites
- Python 3.11+
- Modern browser (Chrome, Edge, Firefox, or Safari)

### Setup & Start

```bash
cd backend
python -m venv .venv

# Windows (PowerShell):
.venv\Scripts\Activate.ps1
# Linux / macOS:
# source .venv/bin/activate

pip install -r requirements.txt

# Seed sample users (researcher1..3 / field123) and 2 projects
python seed.py

# Start the backend + static frontend server
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000` in your browser.

### Regenerating the Service Worker Precache List

Whenever you add, rename, or remove files under `frontend/js/`, `frontend/css/`, or `frontend/icons/`, regenerate `APP_SHELL` in `frontend/sw.js` and bump `CACHE_VERSION`:

```bash
python tools/build_precache.py
```

---

## 2. Managing Users & Projects (`backend/manage.py`)

Use `backend/manage.py` to provision researchers, projects, and memberships:

```bash
# Add a researcher (omit --password to be prompted securely)
python backend/manage.py add-user --username j.smith --display-name "Jane Smith" --password "strong-password"

# Create a project
python backend/manage.py add-project --name "Indus Delta Survey" --region "Sindh" --description "Wetland transect"

# Add a user to a project (by project name or UUID)
python backend/manage.py add-member --username j.smith --project "Indus Delta Survey"
```

---

## 3. Deploying on a VPS (systemd + Caddy)

Service Workers, Geolocation, and Persistent Storage require **HTTPS** in production. Caddy provides automatic Let's Encrypt TLS certificates with zero manual renewal.

### 3.1 Prepare server directory & Python environment

```bash
sudo useradd --system --create-home --home-dir /opt/fieldsync fieldsync
sudo mkdir -p /opt/fieldsync/data/media /opt/fieldsync/data/backups
# Copy repository into /opt/fieldsync/
sudo chown -R fieldsync:fieldsync /opt/fieldsync

sudo -u fieldsync python3 -m venv /opt/fieldsync/venv
sudo -u fieldsync /opt/fieldsync/venv/bin/pip install -r /opt/fieldsync/backend/requirements.txt
```

### 3.2 Install the `systemd` unit for `uvicorn`

A ready-to-use unit file is provided at [`deploy/fieldsync.service`](deploy/fieldsync.service):

```ini
[Unit]
Description=FieldSync FastAPI Backend (uvicorn)
After=network.target

[Service]
Type=simple
User=fieldsync
Group=fieldsync
WorkingDirectory=/opt/fieldsync/backend
Environment=FIELDSYNC_DB_PATH=/opt/fieldsync/data/fieldsync.db
Environment=FIELDSYNC_MEDIA_DIR=/opt/fieldsync/data/media
ExecStart=/opt/fieldsync/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> **Note:** Keep `--workers 1` when using SQLite + in-memory login rate limiting so all requests share the single-process rate limiter and avoid multi-process SQLite write contention.

```bash
sudo cp deploy/fieldsync.service /etc/systemd/system/fieldsync.service
sudo systemctl daemon-reload
sudo systemctl enable --now fieldsync
```

### 3.3 Configure Caddy with Automatic HTTPS

A sample [`deploy/Caddyfile`](deploy/Caddyfile) is included:

```caddyfile
fieldsync.example.org {
    encode gzip zstd

    reverse_proxy 127.0.0.1:8000 {
        header_up X-Real-IP {remote_host}
    }
}
```

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
# Edit /etc/caddy/Caddyfile to set your real domain name
sudo systemctl reload caddy
```

### 3.4 Automated SQLite Backups

`backend/backup.py` uses SQLite's online backup API (`sqlite3.Connection.backup()`) so it is safe to run while `uvicorn` is serving traffic, and automatically retains the last 7 copies:

```bash
python /opt/fieldsync/backend/backup.py --db /opt/fieldsync/data/fieldsync.db --dest /opt/fieldsync/data/backups --keep 7
```

Add a daily cron job or systemd timer to run it automatically.

---

## 4. Installing the PWA on Android & iOS

### Android (Chrome / Edge)
1. Open your FieldSync HTTPS URL in Chrome.
2. Tap the **Install app** banner or browser menu (**⋮** → **Add to Home screen** / **Install app**).
3. Launch from the home screen icon. FieldSync opens in standalone mode and caches the app shell for offline use.

### iOS / iPadOS (Safari)
1. Open your FieldSync HTTPS URL in **Safari** (third-party iOS browsers cannot install PWAs).
2. Tap the **Share** button (`↑`) and select **Add to Home Screen**.
3. Launch FieldSync from the Home Screen icon.

> **Important iOS Limitations:**
> - **No Background Sync API:** iOS Safari/WebKit does not support the Service Worker `sync` event. Syncing happens automatically when FieldSync is open in the foreground (`online` event, `visibilitychange`, and the 30-second polling loop), or when you tap **Sync Now** in Settings.
> - **Storage Eviction Risk if Not Installed:** Safari enforces a 7-day script-writable storage eviction cap on browser tabs that are not visited. **Installing FieldSync to the Home Screen** and granting Persistent Storage in **Settings → Storage Quota → Request Persistent Storage** substantially reduces eviction risk. Still, researchers should sync regularly and use **Settings → Local Backup (Export JSON / CSV)** as a last-resort backup before clearing browser data.

---

## 5. Service Worker Verification Steps

1. **Cold start offline after install:**
   - Open FieldSync online, wait for the Service Worker to reach `activated` in DevTools (**Application → Service Workers**).
   - Enable **Offline** in DevTools Network tab (or disable Wi-Fi).
   - Hard-close/reopen the tab and navigate to `http://127.0.0.1:8000/`.
   - **Expected:** The app shell loads from `fieldsync-static-<CACHE_VERSION>`, Dexie loads from the precached CDN entry, and cached projects/records remain readable.
2. **Update flow (`CACHE_VERSION` bump → toast → reload):**
   - Bump `CACHE_VERSION` in `frontend/sw.js` (e.g. `'v6'` → `'v7'`).
   - Reload the page while online.
   - **Expected:** A non-blocking toast **"A new version is available"** with a **Reload** button appears. Clicking **Reload** sends `SKIP_WAITING` and reloads the page onto the new version.
3. **Never serving stale `/api` responses:**
   - Perform `GET /api/projects` or `GET /api/sync/pull` in DevTools Network tab.
   - **Expected:** Requests bypass the SW cache (`sw.js` returns early for `/api/`) and responses carry `Cache-Control: no-store`. When offline, `/api/*` fails cleanly with a network error rather than returning stale cached JSON.
4. **Cache cleanup:**
   - After activating a new `CACHE_VERSION`, inspect DevTools **Application → Cache Storage**.
   - **Expected:** Only the current `fieldsync-static-<CACHE_VERSION>` cache exists; previous `fieldsync-static-*` caches are deleted in the `activate` handler.

---

## 6. Final QA Checklist

| Requirement | How to verify | Pass |
| --- | --- | --- |
| **offline open** | Install/load app online once, toggle **Offline** in DevTools, close tab, reopen `/`. App shell + cached data load with zero network errors. | [ ] |
| **offline CRUD** | While offline, create a soil/water/wildlife record, edit it, soft-delete it, and restore it. Verify changes persist across page reload and appear in Settings outbox count. | [ ] |
| **photos offline** | While offline, attach a camera/gallery photo to a record. Verify thumbnail renders, `upload_state` is `pending`, and Quota warning/check runs. | [ ] |
| **GPS offline** | While offline, capture coordinates on a record form and record a multi-point GPS track (`Start` → `Pause` → `Resume` → `Stop`). Export GPX offline. | [ ] |
| **auto-sync after reconnect** | Create records, photos, and track points while offline. Restore network; verify `online` event triggers push → pull → media upload → track points upload and header badge clears to `Synced`. | [ ] |
| **multi-device same-dataset edits** | Follow `PROJECT_CONTEXT.md §10`: two browsers offline edit different fields + one shared field on the same record, then reconnect. Verify identical converged state, `field_authors` attribution, conflict banner, and `Use mine` / `Keep current`. | [ ] |
| **crash recovery mid-upload** | Start a GPS track or media upload, force-reload/close the tab mid-operation. On reopen, verify `recording` track is marked `interrupted` (with `Resume as new segment`) and `uploading` media resets to `pending` and completes on next sync. | [ ] |
| **storage warning** | Open **Settings → Storage Quota**; verify meter, percentage, and `Request Persistent Storage` button. Simulate low space (< 20 MB) or `QuotaExceededError` and confirm clear error message with no silent data loss. | [ ] |
| **session expiry** | Expire or delete the session row in SQLite `sessions`, then trigger sync. Verify `401` pauses sync, displays the `Session expired — sign in again` banner, and preserves all unsynced local data across re-login. | [ ] |
| **SW update** | Bump `CACHE_VERSION` in `frontend/sw.js`, reload online, verify **Update ready / Reload** toast appears, click **Reload**, and confirm old `fieldsync-static-*` cache is deleted. | [ ] |
