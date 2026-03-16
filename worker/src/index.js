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

// Known NBA players for headline fallback detection
const NBA_PLAYERS = new Set([
  // Eastern Conference
  'jayson tatum', 'jaylen brown', 'jrue holiday', 'derrick white', 'kristaps porzingis',
  'al horford', 'payton pritchard', 'sam hauser',
  'tyrese maxey', 'joel embiid', 'paul george', 'caleb martin', 'kelly oubre',
  'jalen brunson', 'karl-anthony towns', 'og anunoby', 'mikal bridges', 'josh hart',
  'miles mcbride', 'donte divincenzo',
  'donovan mitchell', 'darius garland', 'evan mobley', 'jarrett allen', 'max strus',
  'caris levert', 'isaac okoro',
  'paolo banchero', 'franz wagner', 'jalen suggs', 'wendell carter', 'cole anthony',
  'scottie barnes', 'immanuel quickley', 'rj barrett', 'jakob poeltl', 'gradey dick',
  'jimmy butler', 'bam adebayo', 'tyler herro', 'terry rozier', 'jaime jaquez',
  'nikola vucevic', 'zach lavine', 'coby white', 'ayo dosunmu', 'patrick williams',
  'giannis antetokounmpo', 'damian lillard', 'khris middleton', 'brook lopez',
  'bobby portis', 'malik beasley',
  'tyrese haliburton', 'pascal siakam', 'myles turner', 'aaron nesmith', 'bennedict mathurin',
  'lamelo ball', 'brandon miller', 'miles bridges', 'mark williams', 'nick richards',
  'trae young', 'dejounte murray', 'jalen johnson', 'clint capela', 'bogdan bogdanovic',
  'cade cunningham', 'jaden ivey', 'ausar thompson', 'marcus sasser', 'jalen duren',
  'bradley beal', 'kyle kuzma', 'jordan poole', 'bilal coulibaly', 'alex sarr',
  // Western Conference
  'nikola jokic', 'jamal murray', 'aaron gordon', 'michael porter', 'kentavious caldwell-pope',
  'luka doncic', 'kyrie irving', 'pj washington', 'daniel gafford', 'dereck lively',
  'shai gilgeous-alexander', 'jalen williams', 'chet holmgren', 'luguentz dort', 'alex caruso',
  'anthony edwards', 'rudy gobert', 'julius randle', 'mike conley', 'naz reid',
  'lebron james', 'anthony davis', 'austin reaves', 'dangelo russell', 'rui hachimura',
  'dalton knecht', 'max christie',
  'stephen curry', 'draymond green', 'andrew wiggins', 'jonathan kuminga', 'kevon looney',
  'brandin podziemski', 'buddy hield',
  'kawhi leonard', 'james harden', 'norman powell', 'ivica zubac', 'terance mann',
  'kevin durant', 'devin booker', 'bradley beal', 'jusuf nurkic', 'grayson allen',
  'ja morant', 'desmond bane', 'jaren jackson', 'marcus smart', 'luke kennard',
  'zion williamson', 'brandon ingram', 'cj mccollum', 'herb jones', 'trey murphy',
  'dejounte murray', 'jonas valanciunas',
  'victor wembanyama', 'devin vassell', 'keldon johnson', 'tre jones', 'jeremy sochan',
  'jalen green', 'alperen sengun', 'jabari smith', 'fred vanvleet', 'dillon brooks',
  'amen thompson', 'cam whitmore',
  'de\'aaron fox', 'domantas sabonis', 'keegan murray', 'malik monk', 'kevin huerter',
  'lauri markkanen', 'collin sexton', 'john collins', 'jordan clarkson', 'walker kessler',
  'anfernee simons', 'deandre ayton', 'jerami grant', 'shaedon sharpe', 'scoot henderson',
  'deni avdija', 'toumani camara',
  // Notable free agents / recently traded
  'chris paul', 'russell westbrook', 'demar derozan', 'paul george',
  'klay thompson', 'tobias harris', 'jonas valanciunas', 'andre drummond',
  'dennis schroder', 'gary trent', 'bruce brown', 'obi toppin', 'isaiah hartenstein',
  'neemias queta', 'derrick rose', 'montrezl harrell', 'dwight howard',
  'alex len', 'jae crowder', 'markelle fultz', 'cam johnson', 'mikal bridges',
  'ben simmons', 'james wiseman', 'marvin bagley', 'john wall',
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
 * Uses the original working article detection, then extracts players
 * from tags (primary) or headline (fallback).
 */
function parseRumors(html) {
  const rumors = [];

  // Match article blocks — this is the proven working approach
  const articlePattern = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let articleMatch;

  while ((articleMatch = articlePattern.exec(html)) !== null) {
    const articleHtml = articleMatch[1];
    const fullArticleHtml = articleMatch[0];
    const articleEnd = articleMatch.index + fullArticleHtml.length;
    // Include content after </article> (tags may be outside the article element)
    const extendedHtml = fullArticleHtml + html.substring(articleEnd, Math.min(html.length, articleEnd + 2000));
    processArticleBlock(articleHtml, extendedHtml, rumors);
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
          const players = extractPlayersFromHeadline(headline);
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
          const players = extractPlayersFromHeadline(headline);
          if (players.length > 0) {
            rumors.push({ headline, url, assetId, players });
          }
        }
      }
    }
  }

  return rumors;
}

function processArticleBlock(html, extendedHtml, rumors) {
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

  // Step 1: Try extracting players from tags inside the article
  let tags = extractTagsFromArticle(html);
  let players = extractPlayersFromTags(tags, headline);

  // Step 1b: If no players found in article, try extended HTML (tags after </article>)
  if (players.length === 0 && extendedHtml) {
    tags = extractTagsFromArticle(extendedHtml);
    players = extractPlayersFromTags(tags, headline);
  }

  // Step 2: Fallback — extract known player names from the headline
  if (players.length === 0) {
    players = extractPlayersFromHeadline(headline);
  }

  // Step 3: Skip if no players found by either method
  if (players.length === 0) return;

  rumors.push({ headline, url, assetId, players });
}

/**
 * Extract tags from an article block HTML.
 * Looks for rel="tag" links, tag containers, and data attributes.
 */
function extractTagsFromArticle(html) {
  const tags = [];

  // Look for rel="tag" links: <a href="..." rel="tag">Tag Name</a>
  // Also match rel='tag', rel="tag noopener", etc.
  const relTagPattern = /<a[^>]*\brel=["'][^"']*\btag\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = relTagPattern.exec(html)) !== null) {
    const tag = stripTags(match[1]).trim();
    if (tag) tags.push(tag);
  }

  // Also try class-based tag links: <a class="tag-link" ...>
  const classTagPattern = /<a[^>]*\bclass=["'][^"']*\btag[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = classTagPattern.exec(html)) !== null) {
    const tag = stripTags(match[1]).trim();
    if (tag && tags.indexOf(tag) === -1) tags.push(tag);
  }

  // Also try href-based tag links: <a href="/tag/player-name">
  const hrefTagPattern = /<a[^>]*href=["'][^"']*\/tag\/([^"'\/]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = hrefTagPattern.exec(html)) !== null) {
    const tag = stripTags(match[2]).trim();
    if (tag && tags.indexOf(tag) === -1) tags.push(tag);
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
 * Filter tags to find valid player names.
 * A valid player tag: 2+ words, not a team name, not a generic tag.
 */
function extractPlayersFromTags(tags, headline) {
  const players = [];
  const seen = new Set();
  const headlineLower = (headline || '').toLowerCase();

  for (const tag of tags) {
    let trimmed = tag.trim();
    // Strip possessive "'s" suffix (e.g. "Luke Kornet's" → "Luke Kornet")
    trimmed = trimmed.replace(/[''\u2019]s$/i, '');
    const lower = trimmed.toLowerCase();
    const wordCount = trimmed.split(/\s+/).length;

    if (wordCount < 2) continue;
    if (NBA_TEAMS.has(lower)) continue;
    if (GENERIC_TAGS.has(lower)) continue;
    if (seen.has(lower)) continue;
    // If headline is available, verify the base name appears in it
    if (headlineLower && !headlineLower.includes(lower)) continue;
    seen.add(lower);

    players.push(trimmed);
  }

  return players;
}

/**
 * Fallback: extract known NBA player names from a headline.
 * Finds all consecutive capitalized word pairs that match known players.
 */
function extractPlayersFromHeadline(headline) {
  const players = [];
  const seen = new Set();

  // Remove common prefixes
  const cleaned = headline
    .replace(/^(Report|Sources|Rumor|NBA|Breaking):\s*/i, '')
    .trim();

  // Try matching each known player name in the headline (case-insensitive)
  const headlineLower = cleaned.toLowerCase();
  for (const player of NBA_PLAYERS) {
    if (headlineLower.includes(player) && !seen.has(player)) {
      seen.add(player);
      // Capitalize the name properly from the headline
      const idx = headlineLower.indexOf(player);
      const originalCase = cleaned.substring(idx, idx + player.length);
      players.push(originalCase);
    }
  }

  // If no known players found, try two-consecutive-capitalized-words heuristic
  // but only if they look like a person's name (not a team or generic phrase)
  if (players.length === 0) {
    const namePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;
    let match;
    while ((match = namePattern.exec(cleaned)) !== null) {
      const candidate = match[1];
      const lower = candidate.toLowerCase();
      if (NBA_TEAMS.has(lower)) continue;
      if (GENERIC_TAGS.has(lower)) continue;
      // Must not be common non-name phrases
      if (/^(The |This |That |When |What |Where |How |Could |Would |Should |Will )/i.test(candidate)) continue;
      if (!seen.has(lower)) {
        seen.add(lower);
        players.push(candidate);
      }
    }
  }

  return players;
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
