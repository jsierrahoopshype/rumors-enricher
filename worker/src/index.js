/**
 * HoopsHype Rumors Monitor — Cloudflare Worker
 *
 * Polls hoopshype.com/rumors/ every 3 minutes (via cron trigger),
 * detects new rumor posts with proper headlines, and sends a
 * Slack notification with a pre-loaded Enricher link.
 */

const HOOPSHYPE_RUMORS_URL = 'https://www.hoopshype.com/rumors/';
const ENRICHER_BASE = 'https://jsierrahoopshype.github.io/rumors-enricher/';
const PRESTO_COPY_BASE = 'https://presto-suite.gannettdigital.com/copy';
const KV_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkForNewRumors(env));
  },

  // Manual trigger via HTTP for testing
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/test') {
      const results = await checkForNewRumors(env);
      return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('HoopsHype Rumors Monitor is running. Use /test to trigger manually.', {
      status: 200,
    });
  },
};

async function checkForNewRumors(env) {
  const results = { found: 0, new: 0, errors: [] };

  let html;
  try {
    const resp = await fetch(HOOPSHYPE_RUMORS_URL, {
      headers: {
        'User-Agent': 'HoopsHype-Rumors-Monitor/1.0',
        'Accept': 'text/html',
      },
    });
    if (!resp.ok) {
      results.errors.push('Failed to fetch rumors page: HTTP ' + resp.status);
      return results;
    }
    html = await resp.text();
  } catch (err) {
    results.errors.push('Fetch error: ' + err.message);
    return results;
  }

  const rumors = parseRumors(html);
  results.found = rumors.length;

  for (const rumor of rumors) {
    const kvKey = 'rumor:' + rumor.assetId;
    const existing = await env.SEEN_RUMORS.get(kvKey);

    if (!existing) {
      // New rumor — store and notify
      await env.SEEN_RUMORS.put(kvKey, JSON.stringify({
        headline: rumor.headline,
        url: rumor.url,
        detectedAt: new Date().toISOString(),
      }), { expirationTtl: KV_TTL });

      try {
        await sendSlackNotification(env, rumor);
        results.new++;
      } catch (err) {
        results.errors.push('Slack error for ' + rumor.assetId + ': ' + err.message);
      }
    }
  }

  return results;
}

/**
 * Parse the HoopsHype rumors page HTML to find headlined rumor entries.
 * Looks for links to /story/sports/nba/rumors/ with <h2> headlines.
 */
function parseRumors(html) {
  const rumors = [];

  // Match article links pointing to rumor stories with headlines
  // Pattern: find anchor tags with /story/sports/nba/ URLs containing h2 headlines
  const articlePattern = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let articleMatch;

  while ((articleMatch = articlePattern.exec(html)) !== null) {
    const articleHtml = articleMatch[1];
    processArticleBlock(articleHtml, rumors);
  }

  // Also try matching div-based layouts common on HoopsHype
  if (rumors.length === 0) {
    // Fallback: look for h2 + link combinations anywhere
    const h2LinkPattern = /<h2[^>]*>\s*<a[^>]*href="([^"]*\/story\/sports\/nba\/[^"]*)"[^>]*>\s*([\s\S]*?)\s*<\/a>\s*<\/h2>/gi;
    let match;
    while ((match = h2LinkPattern.exec(html)) !== null) {
      const url = match[1];
      const headline = stripTags(match[2]).trim();
      if (headline && url) {
        const assetId = extractAssetId(url);
        if (assetId) {
          const playerName = extractPlayerName(headline);
          rumors.push({ headline, url, assetId, playerName });
        }
      }
    }
  }

  // Another fallback: h2 inside a link
  if (rumors.length === 0) {
    const linkH2Pattern = /<a[^>]*href="([^"]*\/story\/sports\/nba\/[^"]*)"[^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]*?<\/a>/gi;
    let match;
    while ((match = linkH2Pattern.exec(html)) !== null) {
      const url = match[1];
      const headline = stripTags(match[2]).trim();
      if (headline && url) {
        const assetId = extractAssetId(url);
        if (assetId) {
          const playerName = extractPlayerName(headline);
          rumors.push({ headline, url, assetId, playerName });
        }
      }
    }
  }

  return rumors;
}

function processArticleBlock(html, rumors) {
  // Check if this block has an h2 headline (proper rumor vs raw tweet embed)
  const h2Match = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (!h2Match) return; // No headline — skip raw tweet embeds

  const headline = stripTags(h2Match[1]).trim();
  if (!headline) return;

  // Find the rumor story URL
  const urlMatch = html.match(/href="([^"]*\/story\/sports\/nba\/[^"]*)"/i);
  if (!urlMatch) return;

  const url = urlMatch[1];
  const assetId = extractAssetId(url);
  if (!assetId) return;

  const playerName = extractPlayerName(headline);
  rumors.push({ headline, url, assetId, playerName });
}

/**
 * Extract asset ID from a URL.
 * HoopsHype URLs typically end with the asset ID, e.g.:
 * /story/sports/nba/rumors/2024/01/15/jaylen-brown-trade/89115076007/
 */
function extractAssetId(url) {
  const match = url.match(/\/(\d{8,})\/?$/);
  if (match) return match[1];

  // Try finding any long number sequence in the URL
  const nums = url.match(/(\d{8,})/);
  return nums ? nums[1] : null;
}

/**
 * Extract a likely player name from a headline.
 * Simple heuristic: take the first 2-3 capitalized words that look like a name.
 */
function extractPlayerName(headline) {
  // Remove common prefixes
  let cleaned = headline
    .replace(/^(Report|Sources|Rumor|NBA|Breaking):\s*/i, '')
    .trim();

  // Try to grab the first name-like sequence (2-3 capitalized words)
  const nameMatch = cleaned.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/);
  if (nameMatch) return nameMatch[1];

  // Fallback: first two words
  const words = cleaned.split(/\s+/).slice(0, 2);
  return words.join(' ');
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ''));
}

/**
 * Send a Slack notification for a new rumor.
 */
async function sendSlackNotification(env, rumor) {
  const webhookUrl = env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error('SLACK_WEBHOOK_URL not configured');
  }

  const playerName = decodeHtmlEntities(rumor.playerName);
  const headline = decodeHtmlEntities(rumor.headline);

  const enricherUrl = ENRICHER_BASE + '?' + new URLSearchParams({
    player: playerName,
    headline: headline.slice(0, 200),
    assetId: rumor.assetId,
  }).toString();

  const prestoCopyUrl = PRESTO_COPY_BASE + '?' + new URLSearchParams({
    assetId: rumor.assetId,
    siteCode: 'SHHP',
  }).toString();

  const payload = {
    text: [
      ':basketball: *New HoopsHype Rumor detected*',
      '',
      '*Player:* ' + playerName,
      '*Headline:* ' + headline,
      '',
      ':arrow_right: <' + enricherUrl + '|Open Enricher>',
      ':arrow_right: <' + prestoCopyUrl + '|Presto Copy URL>',
    ].join('\n'),
  };

  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    throw new Error('Slack webhook returned ' + resp.status);
  }
}
