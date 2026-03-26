# Architecture

## System Design

The Agent Gateway is a stateless HTTP service that bridges REST clients with the Claude Agent SDK. It accepts queries via a streaming NDJSON endpoint, manages Claude sessions for conversation continuity, and provides workspace file management for agent memory, configuration, and skills.

```
                                    +------------------+
                                    |   Claude API     |
                                    |   (Anthropic)    |
                                    +--------^---------+
                                             |
+----------+    HTTP/NDJSON    +-------------+--------------+
|  Client  | ----------------> |       Agent Gateway        |
| (Web App,|    Bearer auth    |                            |
|  CLI,    | <---------------- |  Express 5 + Agent SDK     |
|  CI/CD)  |    NDJSON stream  |                            |
+----------+                   +---+----+----+----+----+----+
                                   |    |    |    |    |
                              +----+  +-+--+ | +--+-+ +----+
                              |Auth|  |Sess| | |Work| |Logs|
                              +----+  +----+ | +----+ +----+
                                             |
                                    +--------v---------+
                                    |   Tool Execution  |
                                    |  Bash, Read, Write|
                                    |  Edit, Glob, Grep |
                                    |  WebSearch, Fetch  |
                                    +-------------------+
```

## Components

### server.ts -- Express Application
Entry point. Configures middleware (JSON parsing, request logging, auth), mounts all routers, and exposes health, logging, session, and settings endpoints directly.

### auth.ts -- API Key Middleware
Parses `API_KEYS` env var at startup into a `Map<key, label>` for O(1) lookup. Validates `Authorization: Bearer <key>` on all routes except `/health`. Attaches `clientLabel` to the request for audit logging.

### query.ts -- Query Endpoint
- **POST /v1/query**: Accepts a prompt, optional system prompt, model, session ID, and tool restrictions. Creates an event cache entry, runs the query through the retry layer, and streams NDJSON events as they occur. Returns `Content-Type: application/x-ndjson`.
- **GET /v1/query/:queryId/events**: Replays cached events for a completed or in-progress query. Supports `?after=<seq>` for resuming from a specific sequence number. For in-progress queries, keeps the connection open and streams new events in real time.

### agent.ts -- Claude SDK Wrapper
Calls `query()` from `@anthropic-ai/claude-agent-sdk` with configured tools and permissions. Translates SDK message types (assistant text, tool_use, tool_result, system status, rate limits) into typed stream events emitted via the `onEvent` callback.

Default tools: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`.

### sessions.ts -- Session Management
Maps client-provided session IDs to internal Claude SDK session IDs. Sessions are:
- **Created** on first query with a given sessionId
- **Reused** when the same sessionId, systemPrompt, and model match
- **Replaced** when systemPrompt or model changes (new Claude session, same client ID)
- **Persisted** to disk (debounced) at `SESSION_PERSIST_PATH`
- **Restored** from disk on startup (expired sessions filtered out)
- **Cleaned** every 5 minutes if `SESSION_IDLE_TIMEOUT_MS > 0`

### retry.ts -- Retry with Exponential Backoff
Wraps `runQuery` with up to 3 retries. Retries on:
- Rate limit errors (429, "overloaded", "throttled")
- Empty or whitespace-only responses

Uses exponential backoff (1s, 2s, 4s) with a 60-second total budget. Emits `rate_limited` events so clients can show retry status. Respects `AbortController` for cancellation.

### event-cache.ts -- Event Cache
Stores NDJSON events in memory keyed by `queryId`. Used by `GET /v1/query/:queryId/events` for replay and real-time streaming. Entries are marked "done" when the query completes. A background timer (every 60s) garbage-collects entries older than `EVENT_CACHE_TTL_MS` (default 30 minutes).

### workspace.ts -- File Operations
Provides safe file CRUD for three workspace sections: `memory`, `agents`, `skills`. All paths are resolved relative to `WORKSPACE_ROOT` (default `$HOME/.claude`). Includes path traversal protection via `safePath()` which validates against directory escape, absolute paths, null bytes, and symlink attacks.

### logging.ts -- Runtime Logging
Three levels: `off`, `info`, `debug`. Level is adjustable at runtime via `PUT /v1/logging`. Request/response logging middleware logs method, URL, status code, and duration (body content only at debug level).

### routes/ssh.ts -- SSH Key Management
**POST /v1/ssh-keys**: Uploads an SSH private key (and optional public key) to `~/.ssh/`. Derives the public key from private if not provided. Writes an SSH config with `StrictHostKeyChecking accept-new`. Validates filename to prevent path injection.

### routes/auth.ts -- Anthropic OAuth
Three-step flow using tmux to interact with Claude CLI:
1. **POST /v1/auth/login**: Starts Claude CLI in a tmux session, captures the OAuth authorization URL.
2. **POST /v1/auth/submit-code**: Sends the authorization code to the tmux session, polls for login success.
3. **GET /v1/auth/status**: Checks if Claude CLI reports a valid login.

### routes/workspace.ts -- Workspace CRUD
Generates GET/PUT/DELETE routes for each workspace section (`memory`, `agents`, `skills`). GET on the section root lists all files. GET/PUT/DELETE on sub-paths reads/writes/deletes individual files.

## Data Flow: Query Request

1. Client sends `POST /v1/query` with `queryId`, `prompt`, optional `sessionId`
2. Auth middleware validates Bearer token
3. Event cache entry created for `queryId`
4. Session resolved: existing session reused or new one created
5. `runQueryWithRetry` calls `runQuery` (agent.ts)
6. Agent SDK streams messages; `agent.ts` translates to events:
   - `text` -- assistant text chunks
   - `tool_use` -- tool invocation (name, input summary)
   - `tool_result` -- tool output (truncated to 3000 chars)
   - `rate_limited` -- rate limit detected, retrying
   - `sdk_status` -- SDK status changes (compacting)
   - `sdk_compact_complete` -- context compaction completed
7. Events are written to response stream (NDJSON) and cached
8. On completion, `done` event emitted with token usage, cost, context stats
9. On error, `error` event emitted with message
10. Event cache entry marked "done"

## Session Lifecycle

```
Client sends sessionId="abc"
    |
    v
Session exists with same prompt + model?
    |                    |
   YES                  NO
    |                    |
    v                    v
Reuse Claude          Create new Claude
session UUID          session UUID
    |                    |
    v                    v
Resume conversation   Start fresh
```

Sessions persist across server restarts via `SESSION_PERSIST_PATH`. The cleanup timer evicts sessions idle longer than `SESSION_IDLE_TIMEOUT_MS`.

## Security Model

- **API Key Auth**: All authenticated routes require a valid Bearer token from `API_KEYS`
- **Path Traversal Protection**: `safePath()` prevents directory escape via `../`, absolute paths, null bytes, and symlink resolution
- **SSH Key Validation**: Filename restricted to `[a-zA-Z0-9_-]` to prevent injection
- **Tool Permissions**: Claude SDK runs with `bypassPermissions` -- the gateway trusts the SDK's tool execution
- **Docker Isolation**: Container runs as `node` user (dropped from root via `gosu`), SSH keys and sessions persist on a named volume
- **Localhost Binding**: Docker compose binds port 3001 to `127.0.0.1` only -- requires a reverse proxy for external access
