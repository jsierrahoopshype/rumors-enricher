# HoopsHype Rumors Monitor — Cloudflare Worker

Polls hoopshype.com/rumors/ every 3 minutes, detects new rumor posts with proper headlines, and sends Slack notifications with pre-loaded Enricher links.

## Setup

### 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Create KV Namespace

```bash
wrangler kv:namespace create SEEN_RUMORS
```

Copy the output `id` into `wrangler.toml` under `[[kv_namespaces]]`.

### 3. Set Slack Webhook Secret

```bash
wrangler secret put SLACK_WEBHOOK_URL
```

Paste your Slack incoming webhook URL when prompted.

### 4. Deploy

```bash
cd worker
wrangler deploy
```

### 5. Test Manually

```bash
curl https://hoopshype-rumors-monitor.<your-subdomain>.workers.dev/test
```

This triggers one check and returns JSON with results.

## How It Works

1. Cron trigger fires every 3 minutes
2. Fetches the HoopsHype rumors page
3. Parses HTML to find rumor articles with `<h2>` headlines and `/story/sports/nba/` URLs
4. Checks each rumor's asset ID against KV storage
5. New rumors get stored in KV (7-day TTL) and trigger a Slack notification
6. Slack message includes links to the Enricher tool and Presto Copy URL
