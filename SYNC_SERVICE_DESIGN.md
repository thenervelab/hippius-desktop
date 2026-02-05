# Hippius Sync Service - Technical Design Document

**Version:** 1.0 (Draft)
**Date:** January 2025
**Status:** Under Review

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Goals & Non-Goals](#3-goals--non-goals)
4. [System Architecture](#4-system-architecture)
5. [Data Model](#5-data-model)
6. [API Specification](#6-api-specification)
7. [Sync Protocol](#7-sync-protocol)
8. [Conflict Resolution](#8-conflict-resolution)
9. [Deletion Policies](#9-deletion-policies)
10. [Security Considerations](#10-security-considerations)
11. [Client Changes](#11-client-changes)
12. [Migration Strategy](#12-migration-strategy)
13. [Observability](#13-observability)
14. [Open Questions](#14-open-questions)
15. [Appendix](#15-appendix)

---

## 1. Executive Summary

This document describes the design of a centralized sync service to replace the current client-side sync engine in the Hippius Desktop application.

**Current State:**
- 2300-line Rust sync engine runs on each client
- Complex conflict detection using CID + ETag comparison
- Per-client state files (prunefiles) stored in S3
- Distributed state makes debugging difficult
- Bug fixes require app updates

**Proposed State:**
- Centralized Rust/Axum service handles all sync logic
- PostgreSQL as single source of truth
- Thin client that watches files and calls REST API
- Centralized logging and observability
- Bug fixes deployed server-side

**Expected Outcome:**
- ~80% reduction in client-side sync code
- Elimination of distributed state management
- Improved debugging and support capabilities
- Faster iteration on sync logic

---

## 2. Problem Statement

### 2.1 Current Architecture Issues

**Complexity:** The client-side sync engine (`sync_engine.rs`) is 2300 lines of complex Rust code handling:
- 4 different deletion policies with different behaviors
- 3-way merge conflict detection
- Per-client state tracking via "prunefiles"
- CAS (Compare-And-Swap) operations for concurrent updates
- Retry logic with exponential backoff
- Rename detection via content hash matching

**Distributed State:** Each client maintains its own "prunefile" in S3:
```
.hippius_manifest_v1/clients/{prunefile_id}/pruned.json
```
This creates:
- Race conditions when multiple clients sync simultaneously
- Complex merge logic when prunefiles conflict
- Difficulty understanding system state (scattered across clients)

**Debugging Difficulty:**
- Logs exist only on user machines
- No visibility into sync operations
- Support requires users to export logs manually
- Reproducing issues requires simulating exact client state

**Update Friction:**
- Bug fixes require new app releases
- Users must update to get fixes
- Can't hotfix critical sync issues

### 2.2 What We Want

- Single source of truth for file state
- Centralized conflict resolution
- Full visibility into sync operations
- Ability to fix issues without app updates
- Simpler client code that's easier to maintain

---

## 3. Goals & Non-Goals

### 3.1 Goals

| Goal | Rationale |
|------|-----------|
| Centralize sync logic | Single source of truth eliminates distributed state issues |
| Maintain all 4 deletion policies | Users rely on current behavior |
| REST + Polling protocol | Simple, debuggable, no WebSocket complexity |
| PostgreSQL storage | Transactional, queryable, battle-tested |
| Direct S3 access | Lower latency than proxying through API |
| Preserve sync semantics | Existing users shouldn't notice behavior changes |

### 3.2 Non-Goals

| Non-Goal | Rationale |
|----------|-----------|
| Offline support | Adds significant complexity; current system doesn't truly support it either |
| Real-time sync (WebSocket) | Polling is simpler and sufficient for file sync use case |
| End-to-end encryption | Out of scope; can be added later |
| File versioning/history | Out of scope for initial implementation |
| Sharing/collaboration | Different feature; out of scope |

### 3.3 Success Criteria

- [ ] All 4 deletion policies work identically to current behavior
- [ ] Multi-client sync works correctly (same user, multiple devices)
- [ ] Conflict detection catches all cases current system catches
- [ ] Sync latency within 2x of current system
- [ ] Client code reduced by >70%

---

## 4. System Architecture

### 4.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         DESKTOP CLIENT (Tauri)                          │
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────┐  │
│  │ File Watcher │───▶│ Sync Client  │───▶│ Local State (SQLite)     │  │
│  │ (notify-rs)  │    │ (reqwest)    │    │ - sync cursors           │  │
│  │              │    │              │    │ - pending operations     │  │
│  └──────────────┘    └──────┬───────┘    └──────────────────────────┘  │
│                             │                                           │
└─────────────────────────────┼───────────────────────────────────────────┘
                              │ HTTPS (REST)
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      SYNC SERVICE (sync.hippius.com)                    │
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────┐  │
│  │    Axum      │───▶│ Sync Engine  │───▶│ PostgreSQL               │  │
│  │   Router     │    │              │    │ - file_states            │  │
│  │              │    │              │    │ - sync_folders           │  │
│  └──────────────┘    └──────┬───────┘    │ - client_cursors         │  │
│                             │            │ - conflict_history       │  │
│  ┌──────────────┐           │            └──────────────────────────┘  │
│  │    Auth      │           │                                          │
│  │  Middleware  │           ▼                                          │
│  │ (validates   │    ┌──────────────┐                                  │
│  │  tokens via  │    │  S3 Client   │                                  │
│  │  api.hippius)│    │ (aws-sdk-s3) │                                  │
│  └──────────────┘    └──────┬───────┘                                  │
│                             │                                           │
└─────────────────────────────┼───────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  S3 Storage      │
                    │  (s3.hippius.com)│
                    │                  │
                    │  /bucket/        │
                    │    file1.txt     │
                    │    file2.pdf     │
                    │    ...           │
                    └──────────────────┘
```

### 4.2 Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| **File Watcher** | Detect local filesystem changes, debounce events |
| **Sync Client** | HTTP client for sync service, upload/download to S3 |
| **Local State** | Store sync cursor, track pending operations |
| **Axum Router** | HTTP routing, request parsing, response formatting |
| **Auth Middleware** | Validate bearer tokens against api.hippius.com |
| **Sync Engine** | Core logic: diff computation, conflict detection, policy enforcement |
| **PostgreSQL** | Persistent storage for all sync state |
| **S3 Client** | Read/write files, generate presigned URLs |

### 4.3 Request Flow Examples

**Upload Flow:**
```
1. Client detects file change (File Watcher)
2. Client computes SHA256 hash of file
3. Client uploads file to S3 directly
4. Client calls POST /upload with {path, hash, s3_etag}
5. Server checks for conflicts against file_states
6. If OK: Server updates file_states, returns {status: 'ok', version: N}
7. If conflict: Server returns {status: 'conflict', details: {...}}
8. Client updates local cursor to version N
```

**Poll Flow:**
```
1. Client calls GET /changes?since_version=N
2. Server queries file_states WHERE version > N
3. Server returns {changes: [...], current_version: M}
4. For each change:
   - 'created'/'modified': Client downloads from S3
   - 'deleted': Client deletes local file (per policy)
5. Client updates local cursor to M
```

---

## 5. Data Model

### 5.1 Database Schema

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- SYNC FOLDERS
-- Represents a user's synced folder configuration
-- ============================================================================
CREATE TABLE sync_folders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id      TEXT NOT NULL,              -- Polkadot SS58 address
    bucket_name     TEXT NOT NULL,              -- S3 bucket name
    folder_prefix   TEXT NOT NULL DEFAULT '',   -- S3 key prefix (empty = root)
    delete_policy   TEXT NOT NULL,              -- See DeletePolicy enum
    display_name    TEXT,                       -- User-friendly name
    is_active       BOOLEAN DEFAULT TRUE,       -- Can be paused
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT valid_delete_policy CHECK (
        delete_policy IN ('upload_only', 'mirror_local_deletes',
                          'restore_from_remote', 'local_only_deletes')
    ),
    CONSTRAINT unique_folder_per_account
        UNIQUE (account_id, bucket_name, folder_prefix)
);

CREATE INDEX idx_sync_folders_account ON sync_folders(account_id);

-- ============================================================================
-- FILE STATES
-- Single source of truth for each file's current state
-- ============================================================================
CREATE TABLE file_states (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sync_folder_id  UUID NOT NULL REFERENCES sync_folders(id) ON DELETE CASCADE,
    relative_path   TEXT NOT NULL,              -- Path relative to folder_prefix

    -- Content tracking
    content_hash    TEXT,                       -- SHA256 of file content
    s3_etag         TEXT,                       -- S3 ETag (for conditional ops)
    size_bytes      BIGINT,                     -- File size
    mime_type       TEXT,                       -- Optional MIME type

    -- State tracking
    is_deleted      BOOLEAN DEFAULT FALSE,      -- Soft delete flag
    deleted_at      TIMESTAMPTZ,                -- When deleted
    deleted_by      TEXT,                       -- client_id that deleted

    -- Version tracking (monotonically increasing)
    version         BIGINT NOT NULL,            -- Assigned from sequence

    -- Timestamps
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT unique_path_per_folder
        UNIQUE (sync_folder_id, relative_path)
);

CREATE INDEX idx_file_states_folder ON file_states(sync_folder_id);
CREATE INDEX idx_file_states_version ON file_states(sync_folder_id, version);
CREATE INDEX idx_file_states_path ON file_states(sync_folder_id, relative_path);

-- ============================================================================
-- CLIENT CURSORS
-- Tracks each client's sync progress
-- ============================================================================
CREATE TABLE client_cursors (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sync_folder_id  UUID NOT NULL REFERENCES sync_folders(id) ON DELETE CASCADE,
    client_id       TEXT NOT NULL,              -- Unique device identifier

    -- Sync progress
    last_version    BIGINT DEFAULT 0,           -- Last version client processed
    last_sync_at    TIMESTAMPTZ,                -- Last successful sync time

    -- Client metadata
    client_name     TEXT,                       -- e.g., "MacBook Pro"
    client_platform TEXT,                       -- e.g., "darwin", "win32"
    app_version     TEXT,                       -- e.g., "0.1.79"

    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT unique_client_per_folder
        UNIQUE (sync_folder_id, client_id)
);

CREATE INDEX idx_client_cursors_folder ON client_cursors(sync_folder_id);

-- ============================================================================
-- CONFLICT HISTORY
-- Audit log of all conflicts for debugging
-- ============================================================================
CREATE TABLE conflict_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sync_folder_id  UUID NOT NULL REFERENCES sync_folders(id) ON DELETE CASCADE,
    file_state_id   UUID REFERENCES file_states(id) ON DELETE SET NULL,

    -- Conflict details
    relative_path   TEXT NOT NULL,
    client_id       TEXT NOT NULL,

    -- What conflicted
    client_hash     TEXT,                       -- Hash client tried to upload
    server_hash     TEXT,                       -- Hash server had
    client_version  BIGINT,                     -- Version client thought it had
    server_version  BIGINT,                     -- Actual server version

    -- Resolution
    resolution      TEXT NOT NULL,              -- 'client_wins', 'server_wins', 'both_kept'
    conflict_path   TEXT,                       -- Path of conflict copy (if created)

    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_conflict_history_folder ON conflict_history(sync_folder_id);
CREATE INDEX idx_conflict_history_time ON conflict_history(created_at DESC);

-- ============================================================================
-- GLOBAL VERSION SEQUENCE
-- Used to assign monotonically increasing versions
-- ============================================================================
CREATE SEQUENCE file_version_seq START 1;

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Function to get next version number
CREATE OR REPLACE FUNCTION next_file_version()
RETURNS BIGINT AS $$
BEGIN
    RETURN nextval('file_version_seq');
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_folders_updated_at
    BEFORE UPDATE ON sync_folders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER file_states_updated_at
    BEFORE UPDATE ON file_states
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER client_cursors_updated_at
    BEFORE UPDATE ON client_cursors
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

### 5.2 Rust Models

```rust
// src/models/mod.rs

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "text", rename_all = "snake_case")]
pub enum DeletePolicy {
    UploadOnly,
    MirrorLocalDeletes,
    RestoreFromRemote,
    LocalOnlyDeletes,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct SyncFolder {
    pub id: Uuid,
    pub account_id: String,
    pub bucket_name: String,
    pub folder_prefix: String,
    pub delete_policy: DeletePolicy,
    pub display_name: Option<String>,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct FileState {
    pub id: Uuid,
    pub sync_folder_id: Uuid,
    pub relative_path: String,
    pub content_hash: Option<String>,
    pub s3_etag: Option<String>,
    pub size_bytes: Option<i64>,
    pub mime_type: Option<String>,
    pub is_deleted: bool,
    pub deleted_at: Option<DateTime<Utc>>,
    pub deleted_by: Option<String>,
    pub version: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ClientCursor {
    pub id: Uuid,
    pub sync_folder_id: Uuid,
    pub client_id: String,
    pub last_version: i64,
    pub last_sync_at: Option<DateTime<Utc>>,
    pub client_name: Option<String>,
    pub client_platform: Option<String>,
    pub app_version: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub action: ChangeAction,
    pub content_hash: Option<String>,
    pub s3_etag: Option<String>,
    pub size_bytes: Option<i64>,
    pub version: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeAction {
    Created,
    Modified,
    Deleted,
    Renamed { from: String },
}
```

### 5.3 Version Numbering Strategy

The system uses a **global monotonic version sequence** rather than per-file versions:

```
Time →
        v1      v2      v3      v4      v5
        │       │       │       │       │
File A: create  ────────modify──────────
File B: ────────create──────────delete──
File C: ────────────────────────create──
```

**Benefits:**
- Simple "give me everything after version N" queries
- No need to track per-file versions on client
- Efficient change detection

**Query pattern:**
```sql
SELECT * FROM file_states
WHERE sync_folder_id = $1 AND version > $2
ORDER BY version ASC
LIMIT 100;
```

---

## 6. API Specification

### 6.1 Authentication

All endpoints require authentication via Bearer token:

```
Authorization: Bearer <oauth_token>
```

The sync service validates tokens by calling `api.hippius.com`:
```
GET https://api.hippius.com/api/user-profile/
Authorization: Bearer <oauth_token>
```

If valid, returns user's `account_id` (Polkadot address).

### 6.2 Common Headers

**Request Headers:**
| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | Bearer token |
| `X-Client-ID` | Yes | Unique device identifier |
| `X-Client-Version` | No | App version (e.g., "0.1.79") |
| `X-Client-Platform` | No | Platform (e.g., "darwin") |

**Response Headers:**
| Header | Description |
|--------|-------------|
| `X-Request-ID` | Unique request ID for debugging |
| `X-Current-Version` | Latest version number (on relevant endpoints) |

### 6.3 Endpoints

#### 6.3.1 Folder Management

**Create Sync Folder**
```
POST /api/v1/folders

Request:
{
    "bucket_name": "my-bucket",
    "folder_prefix": "documents/",       // optional, default ""
    "delete_policy": "mirror_local_deletes",
    "display_name": "My Documents"       // optional
}

Response (201 Created):
{
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "account_id": "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    "bucket_name": "my-bucket",
    "folder_prefix": "documents/",
    "delete_policy": "mirror_local_deletes",
    "display_name": "My Documents",
    "is_active": true,
    "created_at": "2025-01-06T12:00:00Z"
}

Errors:
- 400: Invalid delete_policy
- 409: Folder already exists for this account/bucket/prefix
```

**List Sync Folders**
```
GET /api/v1/folders

Response (200 OK):
{
    "folders": [
        {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "bucket_name": "my-bucket",
            "folder_prefix": "documents/",
            "delete_policy": "mirror_local_deletes",
            "display_name": "My Documents",
            "is_active": true,
            "file_count": 42,
            "total_size_bytes": 1048576,
            "last_sync_at": "2025-01-06T12:00:00Z"
        }
    ]
}
```

**Get Sync Folder**
```
GET /api/v1/folders/:folder_id

Response (200 OK):
{
    "id": "550e8400-e29b-41d4-a716-446655440000",
    // ... full folder details
    "stats": {
        "file_count": 42,
        "deleted_count": 3,
        "total_size_bytes": 1048576,
        "last_change_version": 156,
        "connected_clients": 2
    }
}

Errors:
- 404: Folder not found
- 403: Folder belongs to different account
```

**Update Sync Folder**
```
PATCH /api/v1/folders/:folder_id

Request:
{
    "delete_policy": "upload_only",      // optional
    "display_name": "New Name",          // optional
    "is_active": false                   // optional (pause sync)
}

Response (200 OK):
{
    // Updated folder object
}
```

**Delete Sync Folder**
```
DELETE /api/v1/folders/:folder_id

Query params:
- delete_s3_files=true/false (default: false)

Response (204 No Content)

Note: By default, only removes sync tracking.
S3 files remain unless delete_s3_files=true.
```

#### 6.3.2 Sync Operations

**Get Changes (Polling)**
```
GET /api/v1/folders/:folder_id/changes?since_version=0&limit=100

Response (200 OK):
{
    "changes": [
        {
            "path": "report.pdf",
            "action": "created",
            "content_hash": "abc123...",
            "s3_etag": "\"d41d8cd98f00b204e9800998ecf8427e\"",
            "size_bytes": 102400,
            "version": 42
        },
        {
            "path": "old-file.txt",
            "action": "deleted",
            "content_hash": null,
            "version": 43
        },
        {
            "path": "renamed.txt",
            "action": "renamed",
            "from_path": "original.txt",
            "content_hash": "def456...",
            "version": 44
        }
    ],
    "current_version": 156,
    "has_more": false
}

Notes:
- Returns empty changes array if since_version == current_version
- Client should poll periodically (e.g., every 5-30 seconds)
- Use has_more to paginate large change sets
```

**Report Upload**
```
POST /api/v1/folders/:folder_id/upload

Request:
{
    "path": "documents/report.pdf",
    "content_hash": "sha256:abc123...",
    "s3_etag": "\"d41d8cd98f00b204e9800998ecf8427e\"",
    "size_bytes": 102400,
    "base_version": 41                   // Version client last synced
}

Response (200 OK) - Success:
{
    "status": "ok",
    "version": 42
}

Response (200 OK) - Conflict:
{
    "status": "conflict",
    "conflict_type": "concurrent_modification",
    "server_hash": "def456...",
    "server_version": 42,
    "resolution": "rename_and_retry",
    "suggested_conflict_path": "documents/report.conflict-20250106-120000-abc123.pdf"
}

Notes:
- Client should upload to S3 BEFORE calling this endpoint
- base_version helps detect concurrent modifications
- On conflict, client should rename local file and retry
```

**Confirm Download**
```
POST /api/v1/folders/:folder_id/download-complete

Request:
{
    "path": "documents/report.pdf",
    "version": 42
}

Response (200 OK):
{
    "status": "ok"
}

Notes:
- Updates client cursor
- Optional but recommended for accurate sync tracking
```

**Report Deletion**
```
POST /api/v1/folders/:folder_id/delete

Request:
{
    "path": "documents/old-report.pdf",
    "base_version": 41
}

Response (200 OK):
{
    "status": "ok",
    "version": 43,
    "action_taken": "deleted_remote"     // or "marked_deleted", "no_action"
}

Response (200 OK) - Conflict:
{
    "status": "conflict",
    "conflict_type": "file_modified_on_server",
    "server_version": 42,
    "resolution": "no_delete"
}

Notes:
- Behavior depends on delete_policy
- See Section 9 for policy-specific behavior
```

**Report Rename**
```
POST /api/v1/folders/:folder_id/rename

Request:
{
    "from_path": "documents/old-name.pdf",
    "to_path": "documents/new-name.pdf",
    "content_hash": "abc123...",         // Hash of file being renamed
    "base_version": 41
}

Response (200 OK):
{
    "status": "ok",
    "version": 44
}

Response (200 OK) - Conflict:
{
    "status": "conflict",
    "conflict_type": "target_exists",
    "resolution": "rename_target"
}
```

**Bulk Sync (Initial Sync)**
```
POST /api/v1/folders/:folder_id/bulk-sync

Request:
{
    "local_files": [
        {
            "path": "report.pdf",
            "content_hash": "abc123...",
            "size_bytes": 102400
        },
        {
            "path": "notes.txt",
            "content_hash": "def456...",
            "size_bytes": 1024
        }
    ],
    "client_cursor": 0                   // 0 for initial sync
}

Response (200 OK):
{
    "to_upload": [
        {
            "path": "report.pdf",
            "reason": "not_on_server"
        }
    ],
    "to_download": [
        {
            "path": "server-file.pdf",
            "s3_etag": "\"xyz789...\"",
            "size_bytes": 51200,
            "reason": "not_on_client"
        }
    ],
    "to_delete_local": [
        {
            "path": "deleted-file.txt",
            "reason": "deleted_on_server"
        }
    ],
    "conflicts": [
        {
            "path": "shared.txt",
            "reason": "hash_mismatch",
            "local_hash": "abc...",
            "server_hash": "def...",
            "suggested_resolution": "keep_both"
        }
    ],
    "up_to_date": [
        "notes.txt"
    ],
    "current_version": 156
}

Notes:
- Used for initial sync or full resync
- Client should process in order: conflicts → uploads → downloads → deletes
- After processing, client cursor should be set to current_version
```

#### 6.3.3 Utility Endpoints

**Health Check**
```
GET /health

Response (200 OK):
{
    "status": "healthy",
    "version": "1.0.0",
    "db_connected": true,
    "s3_connected": true
}
```

**User Stats**
```
GET /api/v1/stats

Response (200 OK):
{
    "account_id": "5Grwva...",
    "total_folders": 3,
    "total_files": 142,
    "total_size_bytes": 52428800,
    "active_clients": 2,
    "last_sync_at": "2025-01-06T12:00:00Z"
}
```

---

## 7. Sync Protocol

### 7.1 Client State Machine

```
┌─────────────┐
│    IDLE     │◀──────────────────────────────────┐
└──────┬──────┘                                   │
       │ file change detected OR poll timer       │
       ▼                                          │
┌─────────────┐                                   │
│   SYNCING   │                                   │
└──────┬──────┘                                   │
       │                                          │
       ├─────── local change ─────▶ UPLOADING ────┤
       │                                          │
       ├─────── poll changes ─────▶ DOWNLOADING ──┤
       │                                          │
       └─────── no changes ───────────────────────┘
```

### 7.2 Polling Strategy

**Recommended intervals:**
| Condition | Poll Interval |
|-----------|---------------|
| Recent activity (< 1 min) | 5 seconds |
| Moderate activity (< 5 min) | 15 seconds |
| Idle | 30 seconds |
| App in background | 60 seconds |

**Backoff on errors:**
- First error: 5 seconds
- Second error: 15 seconds
- Third+ error: 60 seconds
- Reset on success

### 7.3 Upload Protocol

```
Client                          Server                          S3
  │                               │                              │
  │  1. Compute SHA256 hash       │                              │
  │                               │                              │
  │  2. PUT file ─────────────────┼─────────────────────────────▶│
  │                               │                              │
  │  3. Receive ETag ◀────────────┼──────────────────────────────│
  │                               │                              │
  │  4. POST /upload ────────────▶│                              │
  │     {path, hash, etag,        │                              │
  │      base_version}            │                              │
  │                               │  5. Check conflicts          │
  │                               │     UPDATE file_states       │
  │                               │                              │
  │  6. Receive response ◀────────│                              │
  │     {status, version}         │                              │
  │                               │                              │
  │  7. Update local cursor       │                              │
  │                               │                              │
```

### 7.4 Download Protocol

```
Client                          Server                          S3
  │                               │                              │
  │  1. GET /changes?since=N ────▶│                              │
  │                               │  2. Query file_states        │
  │  3. Receive changes ◀─────────│                              │
  │                               │                              │
  │  For each 'created'/'modified':                              │
  │                               │                              │
  │  4. GET file ─────────────────┼─────────────────────────────▶│
  │                               │                              │
  │  5. Receive file ◀────────────┼──────────────────────────────│
  │                               │                              │
  │  6. Write to local disk       │                              │
  │                               │                              │
  │  7. POST /download-complete ─▶│                              │
  │     {path, version}           │  8. Update client_cursor     │
  │                               │                              │
```

### 7.5 Initial Sync Protocol

```
1. Client scans local folder
   - Build list of {path, hash, size} for all files

2. Client calls POST /bulk-sync
   - Send full local file list
   - Receive categorized response

3. Client processes response in order:
   a. Handle conflicts first (user decision or automatic)
   b. Upload files in to_upload list
   c. Download files in to_download list
   d. Delete local files in to_delete_local list

4. Client sets cursor to current_version from response

5. Client enters normal polling loop
```

---

## 8. Conflict Resolution

### 8.1 Conflict Types

| Type | Description | Detection |
|------|-------------|-----------|
| **Concurrent Modification** | Same file modified on multiple clients | base_version < server_version AND hash differs |
| **Edit/Delete** | One client edited, another deleted | Upload arrives for deleted file |
| **Rename Collision** | Two clients rename to same target | rename target already exists |
| **Hash Mismatch** | Content differs unexpectedly | Hash comparison during bulk-sync |

### 8.2 Server-Side Conflict Detection

```rust
// Pseudocode for conflict detection during upload

fn check_upload_conflict(
    folder_id: Uuid,
    path: &str,
    client_hash: &str,
    client_base_version: i64,
    client_id: &str,
) -> Result<UploadResult, Error> {
    // Get current server state
    let server_state = get_file_state(folder_id, path)?;

    match server_state {
        None => {
            // File doesn't exist on server - no conflict
            create_file_state(folder_id, path, client_hash)?;
            Ok(UploadResult::Ok { version: new_version })
        }

        Some(state) if state.is_deleted => {
            // File was deleted on server
            // Resurrect it with client's content
            resurrect_file_state(state.id, client_hash)?;
            Ok(UploadResult::Ok { version: new_version })
        }

        Some(state) if state.content_hash == client_hash => {
            // Same content - no conflict (duplicate upload)
            Ok(UploadResult::Ok { version: state.version })
        }

        Some(state) if state.version <= client_base_version => {
            // Client has seen latest version - safe to update
            update_file_state(state.id, client_hash)?;
            Ok(UploadResult::Ok { version: new_version })
        }

        Some(state) => {
            // CONFLICT: Server has newer version client hasn't seen
            record_conflict(folder_id, path, client_id, client_hash, &state);

            Ok(UploadResult::Conflict {
                conflict_type: "concurrent_modification",
                server_hash: state.content_hash,
                server_version: state.version,
                suggested_path: generate_conflict_path(path, client_id),
            })
        }
    }
}
```

### 8.3 Conflict Resolution Strategy

The sync service uses a **"both versions survive"** strategy for most conflicts:

1. **Server version wins** for the canonical path
2. **Client version saved** with conflict suffix
3. **User decides** what to keep (can delete either)

**Conflict file naming:**
```
{name}.conflict-{date}-{time}-{client_short}.{ext}

Examples:
report.pdf           → report.conflict-20250106-143022-a1b2c3.pdf
document.txt         → document.conflict-20250106-143022-a1b2c3.txt
archive.tar.gz       → archive.conflict-20250106-143022-a1b2c3.tar.gz
```

Where:
- `date` = YYYYMMDD
- `time` = HHMMSS
- `client_short` = first 6 chars of client_id

---

## 9. Deletion Policies

### 9.1 Policy Definitions

#### UploadOnly
**Philosophy:** "Client is source of truth, server is backup"

| Event | Behavior |
|-------|----------|
| Client creates file | Upload to server |
| Client modifies file | Upload new version |
| Client deletes file | Mark `locally_deleted=true` in client state; **no server delete** |
| Server has new file | **Do not download** (unless client previously had it) |
| Server file modified | Download if client has local copy |
| Server file deleted | Delete local copy |
| Conflict | Rename local file, keep both versions |

#### MirrorLocalDeletes
**Philosophy:** "Full two-way sync"

| Event | Behavior |
|-------|----------|
| Client creates file | Upload to server |
| Client modifies file | Upload new version |
| Client deletes file | **Delete from server** |
| Server has new file | **Download to client** |
| Server file modified | Download new version |
| Server file deleted | Delete local copy |
| Conflict | Rename local file, keep both versions |

#### RestoreFromRemote
**Philosophy:** "Server is source of truth"

| Event | Behavior |
|-------|----------|
| Client creates file | Upload to server |
| Client modifies file | Upload new version |
| Client deletes file | **Restore from server on next sync** |
| Server has new file | Download to client |
| Server file modified | Download new version |
| Server file deleted | Delete local copy |
| Conflict | Server version wins, local renamed |

#### LocalOnlyDeletes
**Philosophy:** "Remote backup with local control"

| Event | Behavior |
|-------|----------|
| Client creates file | Upload to server |
| Client modifies file | Upload new version |
| Client deletes file | **Local delete only**; file remains on server |
| Server has new file | Do not download (unless resurrection) |
| Server file modified | Download if client has local copy |
| Server file deleted | No local action |
| Conflict | Rename local file, keep both versions |

### 9.2 Policy Comparison Matrix

| Scenario | UploadOnly | MirrorLocalDeletes | RestoreFromRemote | LocalOnlyDeletes |
|----------|------------|--------------------|--------------------|-------------------|
| New remote file | Skip | Download | Download | Skip |
| Modified remote | Download* | Download | Download | Download* |
| Deleted remote | Delete local | Delete local | Delete local | No action |
| Local delete | Keep remote | Delete remote | Restore local | Keep remote |

*Only if client has local copy

### 9.3 Policy Implementation

```rust
// Pseudocode for policy-aware change processing

fn process_remote_change(
    policy: DeletePolicy,
    change: &FileChange,
    local_state: Option<&LocalFile>,
) -> Vec<ClientAction> {
    let mut actions = vec![];

    match (&change.action, policy) {
        // New file on server
        (ChangeAction::Created, DeletePolicy::UploadOnly) => {
            // Skip - don't download new files
        }
        (ChangeAction::Created, DeletePolicy::LocalOnlyDeletes) => {
            // Skip - don't download new files
        }
        (ChangeAction::Created, _) => {
            actions.push(ClientAction::Download(change.path.clone()));
        }

        // Modified file on server
        (ChangeAction::Modified, _) => {
            if local_state.is_some() {
                // We have it locally - download update
                actions.push(ClientAction::Download(change.path.clone()));
            }
            // If we don't have it, policy determines behavior
            // (handled by Created case logic)
        }

        // Deleted file on server
        (ChangeAction::Deleted, DeletePolicy::LocalOnlyDeletes) => {
            // Don't delete local files based on server state
        }
        (ChangeAction::Deleted, _) => {
            if local_state.is_some() {
                actions.push(ClientAction::DeleteLocal(change.path.clone()));
            }
        }

        // Renamed file on server
        (ChangeAction::Renamed { from }, _) => {
            if local_state.is_some() {
                actions.push(ClientAction::RenameLocal {
                    from: from.clone(),
                    to: change.path.clone(),
                });
            }
        }
    }

    actions
}
```

---

## 10. Security Considerations

### 10.1 Authentication & Authorization

**Token Validation:**
- All requests require valid Bearer token
- Tokens validated against `api.hippius.com` on each request
- Consider caching validation results (5 min TTL)

**Authorization:**
- Users can only access their own sync folders
- `account_id` extracted from validated token
- All queries scoped by `account_id`

```rust
// Example authorization check
async fn authorize_folder_access(
    account_id: &str,
    folder_id: Uuid,
    db: &PgPool,
) -> Result<SyncFolder, ApiError> {
    let folder = sqlx::query_as!(
        SyncFolder,
        "SELECT * FROM sync_folders WHERE id = $1 AND account_id = $2",
        folder_id,
        account_id
    )
    .fetch_optional(db)
    .await?;

    folder.ok_or(ApiError::NotFound)
}
```

### 10.2 S3 Security

**Credential Management:**
- Sync service has dedicated S3 credentials
- Credentials stored in environment variables or secrets manager
- Never logged or exposed in responses

**Access Control:**
- Service can only access buckets for authenticated users
- Consider S3 bucket policies to restrict access patterns

**Presigned URLs (Future):**
- For large files, consider presigned URLs for direct client→S3 transfer
- Reduces sync service bandwidth
- URLs short-lived (5-15 minutes)

### 10.3 Rate Limiting

```
Per-account limits:
- 100 requests/minute for polling endpoints
- 1000 requests/minute for upload/download notifications
- 10 bulk-sync requests/hour

Per-IP limits:
- 1000 requests/minute (catches abuse from multiple accounts)
```

### 10.4 Input Validation

**Path Validation:**
```rust
fn validate_path(path: &str) -> Result<(), ValidationError> {
    // No empty paths
    if path.is_empty() {
        return Err(ValidationError::EmptyPath);
    }

    // No path traversal
    if path.contains("..") {
        return Err(ValidationError::PathTraversal);
    }

    // No absolute paths
    if path.starts_with('/') {
        return Err(ValidationError::AbsolutePath);
    }

    // No null bytes
    if path.contains('\0') {
        return Err(ValidationError::NullByte);
    }

    // Reasonable length
    if path.len() > 1024 {
        return Err(ValidationError::PathTooLong);
    }

    Ok(())
}
```

---

## 11. Client Changes

### 11.1 Files to Remove

```
src-tauri/src/sync_engine.rs         # DELETE - 2300 lines
```

### 11.2 Files to Add

```
src-tauri/src/sync_client.rs         # NEW - REST client (~300 lines)
```

### 11.3 Files to Modify

```
src-tauri/src/commands/syncing.rs    # Refactor to use sync_client
src-tauri/src/private_folder_sync.rs # Simplify to watch + delegate
src-tauri/src/main.rs                # Update command registration
```

### 11.4 New Client Architecture

```rust
// src/sync_client.rs - Simplified client

pub struct SyncClient {
    http: reqwest::Client,
    base_url: String,
    auth_token: String,
    client_id: String,
}

impl SyncClient {
    pub async fn get_changes(&self, folder_id: Uuid, since: i64)
        -> Result<ChangesResponse>;

    pub async fn report_upload(&self, folder_id: Uuid, upload: UploadReport)
        -> Result<UploadResponse>;

    pub async fn report_delete(&self, folder_id: Uuid, path: &str)
        -> Result<DeleteResponse>;

    pub async fn bulk_sync(&self, folder_id: Uuid, local_files: Vec<LocalFile>)
        -> Result<BulkSyncResponse>;
}

// Main sync loop - drastically simplified
pub async fn sync_loop(
    client: SyncClient,
    folder_id: Uuid,
    local_path: PathBuf,
    s3_client: S3Client,
) {
    let mut cursor = load_cursor();

    loop {
        // 1. Check for remote changes
        let changes = client.get_changes(folder_id, cursor).await?;

        for change in changes.changes {
            match change.action {
                ChangeAction::Created | ChangeAction::Modified => {
                    let data = s3_client.download(&change.path).await?;
                    write_file(&local_path.join(&change.path), &data)?;
                }
                ChangeAction::Deleted => {
                    delete_file(&local_path.join(&change.path))?;
                }
            }
        }

        cursor = changes.current_version;
        save_cursor(cursor);

        // 2. Check for local changes (from file watcher queue)
        while let Some(local_change) = local_changes.try_recv() {
            match local_change {
                LocalChange::Modified(path) => {
                    let data = read_file(&path)?;
                    let hash = sha256(&data);
                    s3_client.upload(&path, &data).await?;
                    client.report_upload(folder_id, UploadReport {
                        path, hash, ...
                    }).await?;
                }
                LocalChange::Deleted(path) => {
                    client.report_delete(folder_id, &path).await?;
                }
            }
        }

        sleep(poll_interval()).await;
    }
}
```

### 11.5 Code Reduction Summary

| Component | Before | After | Reduction |
|-----------|--------|-------|-----------|
| sync_engine.rs | 2300 lines | 0 lines | -2300 |
| sync_client.rs | 0 lines | ~300 lines | +300 |
| syncing.rs | ~400 lines | ~150 lines | -250 |
| private_folder_sync.rs | ~300 lines | ~100 lines | -200 |
| **Total** | ~3000 lines | ~550 lines | **~82% reduction** |

---

## 12. Migration Strategy

### 12.1 Data Migration

**Current state stored in S3:**
```
.hippius_manifest_v1/
├── sync_state.json              # Global manifest
└── clients/
    └── {prunefile_id}/
        └── pruned.json          # Per-client state
```

**Migration approach:**
1. Read manifest from S3
2. For each entry in manifest:
   - Create corresponding `file_state` row in PostgreSQL
   - Set version = sequential number
3. For each prunefile:
   - Create `client_cursor` with appropriate version

**Migration script pseudocode:**
```python
def migrate_folder(bucket_name, folder_prefix, account_id):
    # 1. Create sync_folder
    folder_id = create_sync_folder(bucket_name, folder_prefix, account_id)

    # 2. Read manifest
    manifest = s3.get_object(bucket_name, f"{folder_prefix}.hippius_manifest_v1/sync_state.json")

    # 3. Create file_states
    version = 1
    for path, meta in manifest['entries'].items():
        create_file_state(
            folder_id=folder_id,
            path=path,
            content_hash=meta.get('cid'),
            s3_etag=meta.get('etag'),
            is_deleted=(meta.get('deletion_count', 0) > meta.get('resurrection_count', 0)),
            version=version,
        )
        version += 1

    # 4. Create client cursors from prunefiles
    prunefiles = s3.list_objects(bucket_name, f"{folder_prefix}.hippius_manifest_v1/clients/")
    for pf in prunefiles:
        client_id = extract_client_id(pf.key)
        create_client_cursor(
            folder_id=folder_id,
            client_id=client_id,
            last_version=version,  # Start fresh
        )
```

### 12.2 Rollout Plan

**Phase 1: Shadow Mode**
- Deploy sync service
- New client version writes to both old and new systems
- Compare results, fix discrepancies
- Duration: 2 weeks

**Phase 2: Read from New**
- Client reads from new system, writes to both
- Old system as fallback
- Duration: 2 weeks

**Phase 3: Full Migration**
- Client uses only new system
- Old sync code removed
- Old S3 manifest files archived (not deleted)
- Duration: 1 week

**Phase 4: Cleanup**
- Remove shadow mode code
- Archive/delete old manifest files
- Remove old sync_engine.rs

### 12.3 Rollback Plan

If critical issues discovered:
1. Client has feature flag to switch back to old system
2. Old manifest files preserved for rollback
3. Can re-enable old sync_engine.rs via flag

---

## 13. Observability

### 13.1 Metrics

**Service Metrics:**
```
sync_requests_total{endpoint, status}      # Request count
sync_request_duration_seconds{endpoint}    # Latency histogram
sync_active_connections                    # Current connections
sync_db_pool_size                          # Database pool utilization
```

**Business Metrics:**
```
sync_files_uploaded_total{account}
sync_files_downloaded_total{account}
sync_conflicts_total{type, resolution}
sync_active_folders
sync_active_clients
sync_bytes_transferred{direction}
```

### 13.2 Logging

**Structured logging with:**
- Request ID (for tracing)
- Account ID (for debugging)
- Client ID (for multi-device issues)
- Folder ID (for folder-specific issues)

**Log levels:**
- ERROR: Failed operations, conflicts
- WARN: Retries, slow operations
- INFO: Successful syncs, state changes
- DEBUG: Detailed request/response data

### 13.3 Alerting

| Alert | Condition | Severity |
|-------|-----------|----------|
| High error rate | >5% requests failing | Critical |
| High latency | p99 > 5s | Warning |
| Database down | Health check fails | Critical |
| S3 unreachable | S3 operations failing | Critical |
| Conflict spike | >100 conflicts/hour | Warning |

---

## 14. Open Questions

### 14.1 To Decide Before Implementation

| # | Question | Options | Recommendation |
|---|----------|---------|----------------|
| 1 | How to handle large files (>100MB)? | a) Direct upload b) Presigned URLs c) Chunked upload | Presigned URLs |
| 2 | Should conflict files auto-delete after N days? | a) Yes (30 days) b) No (manual) c) Configurable | Configurable |
| 3 | Max files per sync folder? | a) Unlimited b) 10,000 c) 100,000 | 100,000 with warning |
| 4 | Rate limiting strategy? | a) Per-account b) Per-client c) Both | Both |
| 5 | Where to deploy service? | a) Same infra as API b) Separate c) Edge | Separate |

### 14.2 Future Considerations (Out of Scope)

- End-to-end encryption
- File versioning/history
- Sharing between accounts
- Selective sync (folder filtering)
- Bandwidth throttling
- Delta sync (only changed bytes)

---

## 15. Appendix

### 15.1 Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `invalid_token` | 401 | Authentication failed |
| `folder_not_found` | 404 | Sync folder doesn't exist |
| `access_denied` | 403 | Not your folder |
| `conflict` | 200 | Sync conflict detected (in response body) |
| `rate_limited` | 429 | Too many requests |
| `invalid_path` | 400 | Path validation failed |
| `folder_exists` | 409 | Folder already configured |
| `s3_error` | 502 | S3 operation failed |
| `internal_error` | 500 | Unexpected server error |

### 15.2 Content Hash Format

**Format:** `sha256:{hex_digest}`

**Example:** `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

**Calculation:**
```rust
use sha2::{Sha256, Digest};

fn content_hash(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let digest = hasher.finalize();
    format!("sha256:{}", hex::encode(digest))
}
```

### 15.3 Client ID Generation

**Format:** UUID v4

**Generated once per installation, stored locally.**

```rust
fn get_or_create_client_id() -> String {
    if let Some(id) = load_client_id_from_db() {
        return id;
    }

    let id = Uuid::new_v4().to_string();
    save_client_id_to_db(&id);
    id
}
```

### 15.4 Glossary

| Term | Definition |
|------|------------|
| **Sync Folder** | A configured folder that's being synced |
| **File State** | Server's record of a file's current state |
| **Client Cursor** | Tracks how far a client has synced |
| **Content Hash** | SHA256 hash of file contents |
| **Version** | Monotonically increasing number for change ordering |
| **Delete Policy** | Rules for how deletions propagate |
| **Conflict** | When same file modified by multiple clients |
| **Bulk Sync** | Full folder comparison for initial sync |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-01-06 | - | Initial draft |

---

*End of Document*
