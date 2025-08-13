# Google Maps Scraper Bridge (Vercel KV)

This project contains two serverless API endpoints designed to work together:

- **`/api/gMapsEnd`** — Kickoff endpoint for creating a Google Maps scrape task.
- **`/api/postbackHandler`** — Postback receiver for handling results from the scraping provider.

## 📦 Overview

**Flow:**
1. **Kickoff:** You send scrape parameters to `/api/gMapsEnd` with authentication.
2. **Task Creation:** The script sends the task to your provider, injects a unique `postback_url`, and stores context (like `extra` and per-task `webhook`) in Vercel KV.
3. **Postback:** The provider scrapes Google Maps and calls `/api/postbackHandler?id=<uniqueId>` with results.
4. **Processing:** The handler looks up stored context, formats results, chunks them into batches of 25 items, and forwards each chunk to the webhook.

---

## 📂 Files

### 1. `gMapsEnd.js`
- **Purpose:** Start a scrape task.
- **Key actions:**
  - Validate API token (header: `Authentication`).
  - Rate-limit per IP (default: 1000 req/min).
  - Validate request body (must be a single-item array).
  - Inject `postback_url` (from `BASE_POSTBACK_URL` + uniqueId).
  - Send task to provider (`API_URL` with `API_LOGIN` and `API_PASSWORD`).
  - Save `extra` and optional `webhook` to KV.

### 2. `postbackHandler.js`
- **Purpose:** Handle scrape results.
- **Key actions:**
  - Accept JSON or gzipped payloads.
  - Retrieve `extra` and `webhook` from KV.
  - Count `totalItems` and `uniquePlaceIds`.
  - Normalize work hours format.
  - Split results into chunks of 25.
  - Send each chunk to the webhook (retry on failure).

---

## 🔑 Environment Variables

Set these in **Vercel → Project → Settings → Environment Variables**:

| Variable | Required | Description |
|----------|----------|-------------|
| `API_URL` | ✅ | Provider API endpoint |
| `API_LOGIN` | ✅ | Provider API login username |
| `API_PASSWORD` | ✅ | Provider API password |
| `BASE_POSTBACK_URL` | ✅ | Must end with `id=`, e.g. `https://<your-app>.vercel.app/api/postbackHandler?id=` |
| `WEBHOOK_URL` | ❌ | Default webhook (optional if you pass `webhook` in kickoff body) |
| `AUTH_TOKEN_1` | ✅ | First allowed auth token for kickoff |
| `AUTH_TOKEN_2...` | ❌ | Additional allowed tokens |

> ⚠ If `WEBHOOK_URL` is not set, **every kickoff request must include a `webhook` field** in the body.

---

## 🚀 Deployment

1. **Install dependencies**
   ```bash
   npm install @vercel/kv node-fetch
