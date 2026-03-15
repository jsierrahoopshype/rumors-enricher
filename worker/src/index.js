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

// NBA team names and common non-player tags to exclude
const NBA_TEAMS = new Set([
  'atlanta hawks', 'boston celtics', 'brooklyn nets', 'charlotte hornets',
  'chicago bulls', 'cleveland cavaliers', 'dallas mavericks', 'denver nuggets',
  'detroit pistons', 'golden state warriors', 'houston rockets', 'indiana pacers',
  'la clippers', 'los angeles clippers', 'los angeles lakers', 'la lakers',
  'memphis grizzlies', 'miami heat', 'milwaukee bucks', 'minnesota timberwolves',
  'new orleans pelicans', 'new york knicks', 'oklahoma city thunder',
  'orlando magic', 'philadelphia 76ers', 'phoenix suns', 'portland trail blazers',
  'sacramento kings', 'san antonio spurs', 'toronto raptors', 'utah jazz',
  'washington wizards',
  // Short/alternate names
  'hawks', 'celtics', 'nets', 'hornets', 'bulls', 'cavaliers', 'cavs',
  'mavericks', 'mavs', 'nuggets', 'pistons', 'warriors', 'rockets', 'pacers',
  'clippers', 'lakers', 'grizzlies', 'heat', 'bucks', 'timberwolves', 'wolves',
  'pelicans', 'knicks', 'thunder', 'magic', 'suns', '76ers', 'sixers',
  'trail blazers', 'blazers', 'kings', 'spurs', 'raptors', 'jazz', 'wizards',
]);

const GENERIC_TAGS = new Set([
  'free agency', 'injuries', 'trade', 'nba draft', 'draft', 'nba', 'rumors',
  'trades', 'free agents', 'signings', 'contracts', 'extensions', 'waivers',
  'buyouts', 'salary cap', 'trade deadline', 'offseason', 'preseason',
  'all-star', 'playoffs', 'finals', 'lottery', 'rookie', 'veterans',
  'coaching', 'front office', 'transactions', 'breaking news', 'analysis',
  'nba news', 'hoopshype', 'nba rumors',
]);

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
        players: rumor.players,
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
 * Extracts tags from each article and uses them to identify player names.
 */
function parseRumors(html) {
  const rumors = [];

  // Match article blocks
  const articlePattern = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let articleMatch;

  while ((articleMatch = articlePattern.exec(html)) !== null) {
    const articleHtml = articleMatch[1];
    processArticleBlock(articleHtml, rumors);
  }

  // Fallback: h2 + link combinations
  if (rumors.length === 0) {
    const h2LinkPattern = /<h2[^>]*>\s*<a[^>]*href="([^"]*\/story\/sports\/nba\/[^"]*)"[^>]*>\s*([\s\S]*?)\s*<\/a>\s*<\/h2>/gi;
    let match;
    while ((match = h2LinkPattern.exec(html)) !== null) {
      const url = match[1];
      const headline = stripTags(match[2]).trim();
      if (headline && url) {
        const assetId = extractAssetId(url);
        if (assetId) {
          const tags = extractTagsFromContext(html, url);
          const players = extractPlayersFromTags(tags);
          if (players.length > 0) {
            rumors.push({ headline, url, assetId, players });
          }
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
          const tags = extractTagsFromContext(html, url);
          const players = extractPlayersFromTags(tags);
          if (players.length > 0) {
            rumors.push({ headline, url, assetId, players });
          }
        }
      }
    }
  }

  return rumors;
}

function processArticleBlock(html, rumors) {
  // Check if this block has an h2 headline (proper rumor vs raw tweet embed)
  const h2Match = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (!h2Match) return;

  const headline = stripTags(h2Match[1]).trim();
  if (!headline) return;

  // Find the rumor story URL
  const urlMatch = html.match(/href="([^"]*\/story\/sports\/nba\/[^"]*)"/i);
  if (!urlMatch) return;

  const url = urlMatch[1];
  const assetId = extractAssetId(url);
  if (!assetId) return;

  // Extract tags from the article block
  const tags = extractTagsFromArticle(html);
  const players = extractPlayersFromTags(tags);

  // Skip if no valid player tag found
  if (players.length === 0) return;

  rumors.push({ headline, url, assetId, players });
}

/**
 * Extract tags from an article block HTML.
 * Tags are typically in elements like <a> tags within a tag container,
 * or in data attributes, or rel="tag" links.
 */
function extractTagsFromArticle(html) {
  const tags = [];

  // Look for rel="tag" links: <a href="..." rel="tag">Tag Name</a>
  const relTagPattern = /<a[^>]*rel="tag"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = relTagPattern.exec(html)) !== null) {
    const tag = stripTags(match[1]).trim();
    if (tag) tags.push(tag);
  }

  // Look for tags in common tag container patterns
  if (tags.length === 0) {
    const tagContainerPattern = /<(?:div|span|ul)[^>]*class="[^"]*tag[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|ul)>/gi;
    while ((match = tagContainerPattern.exec(html)) !== null) {
      const containerHtml = match[1];
      const linkPattern = /<a[^>]*>([\s\S]*?)<\/a>/gi;
      let linkMatch;
      while ((linkMatch = linkPattern.exec(containerHtml)) !== null) {
        const tag = stripTags(linkMatch[1]).trim();
        if (tag) tags.push(tag);
      }
    }
  }

  // Look for data-tags or data-keywords attributes
  if (tags.length === 0) {
    const dataTagMatch = html.match(/data-(?:tags|keywords)="([^"]*)"/i);
    if (dataTagMatch) {
      dataTagMatch[1].split(',').forEach(t => {
        const tag = t.trim();
        if (tag) tags.push(tag);
      });
    }
  }

  return tags;
}

/**
 * Fallback: try to find tags near a URL in the full page HTML.
 */
function extractTagsFromContext(fullHtml, url) {
  // Find the URL position and search nearby content for tag patterns
  const urlIdx = fullHtml.indexOf(url);
  if (urlIdx === -1) return [];

  // Grab a window of HTML around the URL
  const start = Math.max(0, urlIdx - 2000);
  const end = Math.min(fullHtml.length, urlIdx + 3000);
  const context = fullHtml.substring(start, end);

  return extractTagsFromArticle(context);
}

/**
 * Filter tags to find valid player names.
 * A valid player tag:
 *   a) Contains 2+ words
 *   b) Is NOT a known NBA team name
 *   c) Is NOT a generic topic tag
 */
function extractPlayersFromTags(tags) {
  const players = [];
  const seen = new Set();

  for (const tag of tags) {
    const trimmed = tag.trim();
    const lower = trimmed.toLowerCase();
    const wordCount = trimmed.split(/\s+/).length;

    // Must be 2+ words
    if (wordCount < 2) continue;

    // Skip team names
    if (NBA_TEAMS.has(lower)) continue;

    // Skip generic tags
    if (GENERIC_TAGS.has(lower)) continue;

    // Deduplicate
    if (seen.has(lower)) continue;
    seen.add(lower);

    players.push(trimmed);
  }

  return players;
}

/**
 * Extract asset ID from a URL.
 */
function extractAssetId(url) {
  const match = url.match(/\/(\d{8,})\/?$/);
  if (match) return match[1];

  const nums = url.match(/(\d{8,})/);
  return nums ? nums[1] : null;
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

  const players = rumor.players.map(p => decodeHtmlEntities(p));
  const playerDisplay = players.join(', ');
  const headline = decodeHtmlEntities(rumor.headline);

  const enricherUrl = ENRICHER_BASE + '?' + new URLSearchParams({
    player: players.join(','),
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
      '*Player' + (players.length > 1 ? 's' : '') + ':* ' + playerDisplay,
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
