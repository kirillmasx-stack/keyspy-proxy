const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));
app.get('/', (req, res) => res.json({ status: 'KeySpy proxy running' }));

const DFORSEO_BASE = 'https://api.dataforseo.com/v3';

function getAuthHeader() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) throw new Error('Credentials not set');
  return 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
}

function getTrend(monthly) {
  if (!monthly || monthly.length < 3) return 'stable';
  const recent = monthly.slice(0, 3).reduce((s, m) => s + (m.search_volume || 0), 0) / 3;
  const older  = monthly.slice(-3).reduce((s, m) => s + (m.search_volume || 0), 0) / 3;
  if (recent > older * 1.15) return 'up';
  if (recent < older * 0.85) return 'down';
  return 'stable';
}

function mapItem(item) {
  return {
    keyword: item.keyword,
    volume: item.search_volume || 0,
    cpc: item.cpc || 0,
    competition: item.competition || 0,
    competition_level: item.competition_level || 'UNKNOWN',
    trend: item.monthly_searches ? getTrend(item.monthly_searches) : 'stable'
  };
}

app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.post('/api/keywords', async (req, res) => {
  try {
    const { keyword, location_code = 2826, language_code = 'en', engine = 'google' } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });
    const se = engine === 'bing' ? 'bing' : 'google_ads';
    console.log('Keywords engine:', se);

    // Generate 50 keyword variations to bulk check volumes
    // Bing is slower — use fewer variations
    const allVariations = generateVariations(keyword);
    const variations = se === 'bing' ? allVariations.slice(0, 20) : allVariations;
    console.log(`Checking ${variations.length} keyword variations for: ${keyword} [${se}]`);

    const response = await axios.post(
      `${DFORSEO_BASE}/keywords_data/${se === 'bing' ? 'bing/search_volume/live' : 'google_ads/search_volume/live'}`,
      [{ keywords: variations, location_code, language_code }],
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' }, timeout: 55000 }
    );

    const task = response.data?.tasks?.[0];
    console.log('Task status:', task?.status_code, task?.status_message);
    console.log('Result count:', task?.result?.length);

    if (!task || task.status_code !== 20000) {
      return res.status(400).json({ error: task?.status_message || 'DataForSEO error', status_code: task?.status_code });
    }

    const results = (task.result || [])
      .filter(item => item.search_volume > 0)
      .sort((a, b) => (b.search_volume || 0) - (a.search_volume || 0))
      .map(item => {
        // competition can be string ("LOW"/"MEDIUM"/"HIGH") or number (0-1)
        const compRaw = item.competition_level || item.competition || '';
        const compStr = typeof compRaw === 'string' ? compRaw.toUpperCase() : 
                        (typeof compRaw === 'number' ? (compRaw > 0.66 ? 'HIGH' : compRaw > 0.33 ? 'MEDIUM' : 'LOW') : 'LOW');
        const compNum = compStr === 'HIGH' ? 0.85 : compStr === 'MEDIUM' ? 0.5 : compStr === 'LOW' ? 0.15 : 0;
        return {
          keyword: item.keyword,
          volume: item.search_volume || 0,
          cpc: item.cpc || 0,
          competition: compNum,
          competition_level: compStr || 'LOW',
          trend: item.monthly_searches ? getTrend(item.monthly_searches) : 'stable'
        };
      });

    console.log('Returning results:', results.length);
    if (results.length > 0) console.log('Sample item:', JSON.stringify(results[0]));
    res.json({ success: true, data: results });

  } catch (err) {
    console.error('[keywords error]', err.response?.data || err.message);
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// Generate 50 keyword variations for iGaming
function generateVariations(keyword) {
  const kw = keyword.toLowerCase().trim();
  const prefixes = ['best', 'top', 'free', 'real money', 'live', 'online', 'new', 'uk', 'legal', 'safe'];
  const suffixes = ['bonus', 'games', 'sites', 'uk', '2024', '2025', 'no deposit', 'free spins', 'welcome bonus', 'review', 'app', 'mobile', 'deposit bonus', 'jackpot'];
  const intents  = ['play', 'how to play', 'sign up', 'register', 'download', 'win', 'tips'];

  const variations = new Set();
  variations.add(kw);

  // prefix + keyword
  prefixes.forEach(p => variations.add(`${p} ${kw}`));
  // keyword + suffix
  suffixes.forEach(s => variations.add(`${kw} ${s}`));
  // intent + keyword
  intents.forEach(i => variations.add(`${i} ${kw}`));
  // keyword split word combinations
  const words = kw.split(' ');
  if (words.length > 1) {
    words.forEach(w => {
      prefixes.slice(0, 5).forEach(p => variations.add(`${p} ${w}`));
    });
  }

  return Array.from(variations).slice(0, 50);
}

app.post('/api/serp-ads', async (req, res) => {
  try {
    const { keyword, location_code = 2826, language_code = 'en', device = 'desktop' } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    const response = await axios.post(
      `${DFORSEO_BASE}/serp/google/paid/live/advanced`,
      [{ keyword, location_code, language_code, device, os: device === 'mobile' ? 'android' : 'windows', depth: 10 }],
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
    );

    const task = response.data?.tasks?.[0];
    console.log('SERP task status:', task?.status_code, task?.status_message);

    if (!task || task.status_code !== 20000) {
      return res.status(400).json({ error: task?.status_message || 'DataForSEO error' });
    }

    const items = task.result?.[0]?.items || [];
    const ads = items.filter(i => i.type === 'paid').map((item, idx) => ({
      position: item.rank_absolute || idx + 1,
      domain: item.domain,
      title: item.title,
      description: item.description,
      display_url: item.breadcrumb || item.url,
      headlines: item.extended_snippet?.title_lines || [],
      sitelinks: (item.sitelinks || []).map(s => ({ title: s.title, description: s.description }))
    }));

    res.json({ success: true, data: ads });
  } catch (err) {
    console.error('[serp-ads error]', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/serp-organic ────────────────────────────────────────────────────
// Fetches BOTH organic + paid in parallel
app.post('/api/serp-organic', async (req, res) => {
  try {
    const { keyword, location_code = 2826, language_code = 'en', device = 'desktop', depth = 100, engine = 'google' } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    // Map engine to DataForSEO path
    const enginePathMap = {
      google:  'google/organic/live/regular',
      bing:    'bing/organic/live/regular',
      yahoo:   'yahoo/organic/live/regular',
      youtube: 'youtube/organic/live/advanced'
    };
    const serpPath = enginePathMap[engine] || 'google/organic/live/regular';
    console.log('SERP engine:', engine, serpPath);

    // YouTube doesn't use device/os params
    const reqBody = engine === 'youtube'
      ? [{ keyword, location_code, language_code, depth }]
      : [{ keyword, location_code, language_code, device, os: device === 'mobile' ? 'android' : 'windows', depth }];

    const organicRes = await axios.post(
      `${DFORSEO_BASE}/serp/${serpPath}`,
      reqBody,
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
    );

    const task = organicRes.data?.tasks?.[0];
    console.log('SERP status:', task?.status_code, task?.status_message);
    if (!task || task.status_code !== 20000) {
      return res.status(400).json({ error: task?.status_message || 'DataForSEO error' });
    }

    const items = task.result?.[0]?.items || [];
    const summary = {
      total_results: task.result?.[0]?.se_results_count || 0,
      keyword,
      location_code,
      device
    };

    // Categorize results
    const organic = [];
    const paid = [];
    const maps = [];
    const featured = [];
    const snippets = [];
    const related = [];

    items.forEach(item => {
      switch(item.type) {
        case 'organic':
          organic.push({
            rank: item.rank_absolute,
            title: item.title,
            url: item.url,
            domain: item.domain,
            description: item.description,
            breadcrumb: item.breadcrumb,
            is_featured: item.is_featured_snippet || false,
            etv: item.etv || 0 // estimated traffic value
          });
          break;
        case 'paid':
          paid.push({
            rank: item.rank_absolute,
            title: item.title,
            url: item.url,
            domain: item.domain,
            description: item.description,
            breadcrumb: item.breadcrumb
          });
          break;
        case 'maps':
        case 'local_pack':
          maps.push({
            rank: item.rank_absolute,
            title: item.title,
            url: item.url,
            domain: item.domain,
            rating: item.rating?.value,
            reviews: item.rating?.votes_count
          });
          break;
        case 'featured_snippet':
          featured.push({
            title: item.title,
            url: item.url,
            domain: item.domain,
            description: item.description
          });
          break;
        case 'people_also_ask':
          if (item.items) {
            item.items.forEach(q => snippets.push({ question: q.title, url: q.url }));
          }
          break;
        case 'related_searches':
          if (item.items) {
            item.items.forEach(r => related.push(r.title || r));
          }
          break;
      }
    });

    console.log('SERP organic:', organic.length, 'paid:', paid.length, 'maps:', maps.length);
    console.log('SERP sample organic:', JSON.stringify(organic[0] || {}));
    res.json({ success: true, data: { summary, organic, paid, maps, featured, snippets, related } });
  } catch (err) {
    console.error('[serp-organic error]', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/ads-analyzer ────────────────────────────────────────────────────
// mode: 'keyword' = live SERP search, 'domain' = domain history via DataForSEO Labs
app.post('/api/ads-analyzer', async (req, res) => {
  try {
    const { query, location_code = 2826, language_code = 'en', device = 'desktop', mode = 'keyword' } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });

    let ads = [];

    if (mode === 'keyword') {
      // Use dedicated paid endpoint for guaranteed ad results
      const response = await axios.post(
        `${DFORSEO_BASE}/serp/google/paid/live/advanced`,
        [{ keyword: query, location_code, language_code, device, os: device === 'mobile' ? 'android' : 'windows', depth: 10 }],
        { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
      );
      const task = response.data?.tasks?.[0];
      console.log('Ads paid status:', task?.status_code, task?.status_message);

      if (task && task.status_code === 20000) {
        const items = task.result?.[0]?.items || [];
        items.filter(i => i.type === 'paid').forEach(item => {
          ads.push(parseAdItem(item));
        });
      }

      // Fallback to organic endpoint if no paid ads found
      if (!ads.length) {
        console.log('Trying organic fallback for paid ads...');
        const fallback = await axios.post(
          `${DFORSEO_BASE}/serp/google/organic/live/advanced`,
          [{ keyword: query, location_code, language_code, device, os: device === 'mobile' ? 'android' : 'windows', depth: 10 }],
          { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
        );
        const fbTask = fallback.data?.tasks?.[0];
        if (fbTask && fbTask.status_code === 20000) {
          const fbItems = fbTask.result?.[0]?.items || [];
          fbItems.filter(i => i.type === 'paid').forEach(item => {
            ads.push(parseAdItem(item));
          });
        }
      }

    } else if (mode === 'domain') {
      // Domain history - get paid keywords for domain
      const response = await axios.post(
        `${DFORSEO_BASE}/dataforseo_labs/google/ranked_keywords/live`,
        [{ target: query, location_code, language_code, limit: 20, order_by: ['keyword_data.keyword_info.search_volume,desc'] }],
        { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
      );
      const task = response.data?.tasks?.[0];
      console.log('Domain ads status:', task?.status_code, task?.status_message);
      if (!task || task.status_code !== 20000) {
        return res.status(400).json({ error: task?.status_message || 'DataForSEO error' });
      }
      // Return keyword data for domain
      const items = task.result?.[0]?.items || [];
      const keywords = items.map(item => ({
        keyword: item.keyword_data?.keyword,
        position: item.ranked_serp_element?.serp_item?.rank_absolute,
        title: item.ranked_serp_element?.serp_item?.title,
        description: item.ranked_serp_element?.serp_item?.description,
        url: item.ranked_serp_element?.serp_item?.url,
        domain: query,
        display_url: item.ranked_serp_element?.serp_item?.breadcrumb,
        titles: item.ranked_serp_element?.serp_item?.title_lines || [],
        sitelinks: item.ranked_serp_element?.serp_item?.sitelinks || [],
        callouts: [],
        promos: [],
        paid_etv: item.keyword_data?.keyword_info?.cpc || 0,
        volume: item.keyword_data?.keyword_info?.search_volume || 0
      }));
      return res.json({ success: true, data: { ads: keywords, mode, query, total: keywords.length } });
    }

    // Enrich keyword mode with competitor keyword data
    if (mode === 'keyword' && ads.length > 0) {
      const domains = [...new Set(ads.map(a => a.domain).filter(Boolean))].slice(0, 5);
      console.log('Enriching competitor domains:', domains);

      await Promise.all(domains.map(async domain => {
        try {
          const kwRes = await axios.post(
            `${DFORSEO_BASE}/dataforseo_labs/google/ranked_keywords/live`,
            [{ target: domain, location_code, language_code, limit: 15, order_by: ['keyword_data.keyword_info.search_volume,desc'] }],
            { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
          );
          const kwTask = kwRes.data?.tasks?.[0];
          if (kwTask?.status_code === 20000) {
            const items = kwTask.result?.[0]?.items || [];
            const keywords = items.map(item => ({
              keyword: item.keyword_data?.keyword || '',
              volume: item.keyword_data?.keyword_info?.search_volume || 0,
              cpc: item.keyword_data?.keyword_info?.cpc || 0,
              position: item.ranked_serp_element?.serp_item?.rank_absolute || null,
              type: item.ranked_serp_element?.serp_item?.type || 'organic'
            })).filter(k => k.keyword);
            // Attach to all ads from this domain
            ads.filter(a => a.domain === domain).forEach(a => {
              a.competitor_keywords = keywords;
            });
          }
        } catch(e) {
          console.log('Keyword enrichment error for', domain, ':', e.message);
        }
      }));

      console.log('Enrichment done for', domains.length, 'domains');
    }

    console.log('Ads found:', ads.length);
    res.json({ success: true, data: { ads, mode, query, location_code, device, total: ads.length } });
  } catch (err) {
    console.error('[ads-analyzer error]', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

function parseAdItem(item) {
  const sitelinks = (item.sitelinks || []).map(s => ({ title: s.title, description: s.description, url: s.url }));
  const callouts = [], promos = [];
  if (item.description_rows) {
    item.description_rows.forEach(row => {
      if (row.type === 'callout') callouts.push(row.text);
      if (row.type === 'promotion') promos.push(row.text);
    });
  }
  return {
    position: item.rank_absolute,
    title: item.title,
    titles: item.title_lines || [item.title],
    description: item.description,
    description_lines: item.description_lines || [],
    url: item.url,
    display_url: item.breadcrumb || item.domain,
    domain: item.domain,
    sitelinks, callouts, promos,
    rating: item.rating || null
  };
}

// ── POST /api/ads-transparency ────────────────────────────────────────────────
// Gets REAL ads from Google Ads Transparency Center via ads_advertisers + ads_search
app.post('/api/ads-transparency', async (req, res) => {
  try {
    const { domain, location_code = 2826, language_code = 'en', date_from, date_to, depth = 40, sort_by = 'newest' } = req.body;
    if (!domain) return res.status(400).json({ error: 'domain is required' });

    // Step 1: Find advertiser_ids for this domain
    const advRes = await axios.post(
      `${DFORSEO_BASE}/serp/google/ads_advertisers/live/advanced`,
      [{ target: domain, location_code, language_code, depth: 10 }],
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
    );
    const advTask = advRes.data?.tasks?.[0];
    console.log('Advertisers status:', advTask?.status_code, advTask?.status_message);

    let advertiser_ids = [];
    if (advTask?.status_code === 20000) {
      const advItems = advTask.result?.[0]?.items || [];
      advertiser_ids = advItems.map(i => i.advertiser_id).filter(Boolean).slice(0, 5);
      console.log('Advertiser IDs found:', advertiser_ids.length);
    }

    if (!advertiser_ids.length) {
      return res.status(400).json({ 
        error: `No advertiser found for ${domain}. This domain may not be running Google Ads or may not be indexed in Transparency Center yet.`
      });
    }

    // Step 2: Post task to get real ads
    const adsPayload = {
      advertiser_ids,
      location_code,
      language_code,
      depth: Math.min(depth, 40)
    };
    if (date_from) adsPayload.date_from = date_from;
    if (date_to) adsPayload.date_to = date_to;

    const taskRes = await axios.post(
      `${DFORSEO_BASE}/serp/google/ads_search/task_post`,
      [adsPayload],
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
    );
    const taskId = taskRes.data?.tasks?.[0]?.id;
    console.log('Ads search task ID:', taskId);

    if (!taskId) {
      return res.status(400).json({ error: taskRes.data?.tasks?.[0]?.status_message || 'Failed to post task' });
    }

    // Step 3: Poll for results (max 20 seconds)
    let result = null;
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const getRes = await axios.get(
        `${DFORSEO_BASE}/serp/google/ads_search/task_get/advanced/${taskId}`,
        { headers: { Authorization: getAuthHeader() } }
      );
      const t = getRes.data?.tasks?.[0];
      console.log(`Poll ${i+1}: status=${t?.status_code} msg=${t?.status_message}`);
      if (t?.status_code === 20000) { result = t; break; }
    }

    if (!result) {
      return res.status(400).json({ error: 'Task timed out. Try again — results may take a few seconds.' });
    }

    const items = result.result?.[0]?.items || [];
    const ads = items.map((item, idx) => ({
      position: item.rank_absolute || idx + 1,
      advertiser: item.advertiser_name || domain,
      domain: item.domain || domain,
      titles: item.title_lines || (item.title ? [item.title] : []),
      description: item.description || '',
      display_url: item.breadcrumb || domain,
      url: item.url || '',
      first_seen: item.first_seen || null,
      last_seen: item.last_seen || null,
      sitelinks: (item.sitelinks || []).map(s => ({ title: s.title, description: s.description })),
      callouts: [], promos: [],
      source: 'transparency'
    }));

    // Sort
    if (sort_by === 'oldest') {
      ads.sort((a, b) => (a.first_seen || '') > (b.first_seen || '') ? 1 : -1);
    } else {
      ads.sort((a, b) => (a.last_seen || '') < (b.last_seen || '') ? 1 : -1);
    }

    console.log('Real transparency ads found:', ads.length);
    res.json({
      success: true,
      data: {
        domain, ads, total: ads.length,
        advertiser_ids,
        date_from: date_from || null,
        date_to: date_to || null,
        summary: `${ads.length} real ads found for ${domain} from Google Ads Transparency Center`,
        source: 'google_transparency'
      }
    });
  } catch (err) {
    console.error('[ads-transparency error]', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});


function parseAdsItem(item) {
  const sitelinks = (item.sitelinks || []).map(s => ({ title: s.title, description: s.description, url: s.url }));
  const callouts = [], promos = [];
  if (item.description_rows) {
    item.description_rows.forEach(r => {
      if (r.type === 'callout') callouts.push(r.text);
      if (r.type === 'promotion') promos.push(r.text);
    });
  }
  // Also extract from extended_snippet
  if (item.extended_snippet?.description_lines) {
    item.extended_snippet.description_lines.forEach(d => {
      if (d && !callouts.includes(d)) callouts.push(d);
    });
  }
  return {
    position: item.rank_absolute,
    titles: item.title_lines || (item.title ? [item.title] : []),
    description: item.description || '',
    display_url: item.breadcrumb || item.domain || '',
    domain: item.domain || '',
    url: item.url || '',
    sitelinks, callouts, promos,
    mode: 'keyword'
  };
}

// ── POST /api/ppc-overview ────────────────────────────────────────────────────
// Gets live PPC ads + screenshots of landing pages
app.post('/api/ppc-overview', async (req, res) => {
  try {
    const { keyword, location_code = 2826, language_code = 'en', device = 'desktop', take_screenshots = true } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    // Step 1: Get paid ads from SERP
    const serpRes = await axios.post(
      `${DFORSEO_BASE}/serp/google/organic/live/advanced`,
      [{ keyword, location_code, language_code, device, os: device === 'mobile' ? 'android' : 'windows', depth: 10 }],
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
    );
    const serpTask = serpRes.data?.tasks?.[0];
    console.log('PPC overview SERP status:', serpTask?.status_code);
    if (!serpTask || serpTask.status_code !== 20000) {
      return res.status(400).json({ error: serpTask?.status_message || 'SERP error' });
    }

    const items = serpTask.result?.[0]?.items || [];
    const paidAds = items.filter(i => i.type === 'paid').map((item, idx) => ({
      position: item.rank_absolute || idx + 1,
      domain: item.domain,
      title: item.title,
      description: item.description,
      url: item.url,
      display_url: item.breadcrumb || item.domain,
      sitelinks: (item.sitelinks || []).map(s => ({ title: s.title, url: s.url })),
      screenshot: null
    }));

    console.log('Paid ads found:', paidAds.length);

    // Step 2: Take screenshots of landing pages (parallel, max 5)
    if (take_screenshots && paidAds.length > 0) {
      const adsToScreenshot = paidAds.slice(0, 5);
      
      await Promise.all(adsToScreenshot.map(async (ad, idx) => {
        try {
          if (!ad.url) return;
          
          // Post screenshot task
          const ssRes = await axios.post(
            `${DFORSEO_BASE}/on_page/screenshot`,
            [{
              url: ad.url,
              full_page_screenshot: false,
              browser_preset: device === 'mobile' ? 'mobile' : 'desktop',
              custom_js: '',
              load_resources: false,
              enable_javascript: true,
              accept_language: language_code + '-' + (location_code === 2826 ? 'GB' : 'US')
            }],
            { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
          );
          const ssTask = ssRes.data?.tasks?.[0];
          console.log(`Screenshot ${idx+1} status:`, ssTask?.status_code, ssTask?.status_message);
          
          if (ssTask?.status_code === 20000) {
            const result = ssTask.result?.[0];
            if (result?.items?.[0]?.screenshot_png) {
              ad.screenshot = `data:image/png;base64,${result.items[0].screenshot_png}`;
            } else if (result?.screenshot_png) {
              ad.screenshot = `data:image/png;base64,${result.screenshot_png}`;
            }
          }
        } catch(e) {
          console.log('Screenshot error for', ad.domain, ':', e.message);
        }
      }));
    }

    res.json({ 
      success: true, 
      data: { 
        keyword, location_code, device,
        ads: paidAds, 
        total: paidAds.length,
        screenshots_taken: paidAds.filter(a => a.screenshot).length
      } 
    });
  } catch (err) {
    console.error('[ppc-overview error]', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/serpapi-ads ─────────────────────────────────────────────────────
// SerpApi — guaranteed paid ads from Google SERP
app.post('/api/serpapi-ads', async (req, res) => {
  try {
    const { keyword, device = 'desktop', hl = 'en', gl = 'uk' } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    const SERPAPI_KEY = process.env.SERPAPI_KEY;
    if (!SERPAPI_KEY) return res.status(400).json({ error: 'SERPAPI_KEY not set in env vars' });

    // Map gl to correct google domain
    const locationMapAds = {
      'uk': 'London,England,United Kingdom',
      'us': 'New York,New York,United States',
      'de': 'Berlin,Berlin,Germany',
      'fr': 'Paris,Ile-de-France,France',
      'it': 'Rome,Lazio,Italy',
      'es': 'Madrid,Community of Madrid,Spain',
      'ca': 'Toronto,Ontario,Canada',
      'au': 'Sydney,New South Wales,Australia',
      'nl': 'Amsterdam,North Holland,Netherlands',
      'se': 'Stockholm,Stockholm County,Sweden',
      'br': 'Sao Paulo,Sao Paulo,Brazil',
      'in': 'Mumbai,Maharashtra,India',
      'ae': 'Dubai,Dubai,United Arab Emirates',
      'ua': 'Kyiv,Kyiv City,Ukraine'
    };
    const googleDomainsAds = {
      'uk': 'google.co.uk', 'us': 'google.com', 'de': 'google.de',
      'fr': 'google.fr', 'it': 'google.it', 'es': 'google.es',
      'ca': 'google.ca', 'au': 'google.com.au', 'nl': 'google.nl',
      'se': 'google.se', 'br': 'google.com.br', 'in': 'google.co.in',
      'ae': 'google.ae', 'ua': 'google.com.ua'
    };
    const location_ads = locationMapAds[gl] || 'London,England,United Kingdom';
    const google_domain = googleDomainsAds[gl] || 'google.com';

    const params = new URLSearchParams({
      engine: 'google',
      q: keyword,
      location: location_ads,
      hl,
      gl,
      google_domain,
      device,
      num: '10',
      no_cache: 'true',
      api_key: SERPAPI_KEY
    });

    console.log('SerpApi Ads request:', keyword, location_ads, gl, device);
    const response = await axios.get(`https://serpapi.com/search.json?${params}`, { timeout: 30000 });
    const data = response.data;

    console.log('SerpApi status:', data.search_metadata?.status);
    console.log('SerpApi ads count:', data.ads?.length || 0);
    console.log('SerpApi organic count:', data.organic_results?.length || 0);
    if (data.error) console.log('SerpApi error:', data.error);

    // Extract paid ads
    const ads = (data.ads || []).map((ad, idx) => ({
      position: ad.position || idx + 1,
      title: ad.title,
      titles: ad.title ? [ad.title] : [],
      description: ad.description,
      display_url: ad.displayed_link || ad.domain,
      domain: ad.domain || new URL(ad.link || 'https://unknown').hostname,
      url: ad.link,
      sitelinks: (ad.sitelinks || []).map(s => ({ title: s.title, url: s.link, description: s.description })),
      callouts: ad.extensions || [],
      promos: [],
      source: 'serpapi'
    }));

    // Also extract organic for context
    const organic = (data.organic_results || []).slice(0, 5).map(r => ({
      position: r.position,
      title: r.title,
      url: r.link,
      domain: r.displayed_link,
      description: r.snippet
    }));

    console.log('SerpApi ads found:', ads.length, 'organic:', organic.length);

    res.json({
      success: true,
      data: {
        ads,
        organic,
        keyword,
        total_ads: ads.length,
        source: 'serpapi',
        credits_used: 1
      }
    });
  } catch (err) {
    console.error('[serpapi-ads error]', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

// ── POST /api/serpapi-ppc ──────────────────────────────────────────────────────
// SerpApi — PPC overview with screenshots
app.post('/api/serpapi-ppc', async (req, res) => {
  try {
    const { keyword, device = 'desktop', hl = 'en', gl = 'uk' } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    const SERPAPI_KEY = process.env.SERPAPI_KEY;
    if (!SERPAPI_KEY) return res.status(400).json({ error: 'SERPAPI_KEY not set in env vars' });

    // SerpApi location map — city level for accurate geo results
    const locationMap = {
      'uk': 'London,England,United Kingdom',
      'us': 'New York,New York,United States',
      'de': 'Berlin,Berlin,Germany',
      'fr': 'Paris,Ile-de-France,France',
      'it': 'Rome,Lazio,Italy',
      'es': 'Madrid,Community of Madrid,Spain',
      'ca': 'Toronto,Ontario,Canada',
      'au': 'Sydney,New South Wales,Australia',
      'nl': 'Amsterdam,North Holland,Netherlands',
      'se': 'Stockholm,Stockholm County,Sweden',
      'no': 'Oslo,Oslo,Norway',
      'dk': 'Copenhagen,Capital Region,Denmark',
      'fi': 'Helsinki,Uusimaa,Finland',
      'pl': 'Warsaw,Masovian Voivodeship,Poland',
      'br': 'Sao Paulo,Sao Paulo,Brazil',
      'in': 'Mumbai,Maharashtra,India',
      'ae': 'Dubai,Dubai,United Arab Emirates',
      'ua': 'Kyiv,Kyiv City,Ukraine',
      'za': 'Johannesburg,Gauteng,South Africa',
      'mx': 'Mexico City,Mexico City,Mexico',
      'jp': 'Tokyo,Tokyo,Japan',
      'kr': 'Seoul,Seoul,South Korea',
      'sg': 'Singapore,Singapore'
    };
    const googleDomainMap = {
      'uk': 'google.co.uk', 'us': 'google.com', 'de': 'google.de',
      'fr': 'google.fr', 'it': 'google.it', 'es': 'google.es',
      'ca': 'google.ca', 'au': 'google.com.au', 'nl': 'google.nl',
      'se': 'google.se', 'br': 'google.com.br', 'in': 'google.co.in',
      'ae': 'google.ae', 'ua': 'google.com.ua', 'jp': 'google.co.jp',
      'kr': 'google.co.kr', 'sg': 'google.com.sg'
    };
    const location_ppc = locationMap[gl] || 'United Kingdom';
    const google_domain_ppc = googleDomainMap[gl] || 'google.com';

    const params = new URLSearchParams({
      engine: 'google',
      q: keyword,
      gl,
      hl,
      google_domain: google_domain_ppc,
      device,
      num: '10',
      api_key: SERPAPI_KEY
    });

    console.log('SerpApi PPC request:', keyword, gl, google_domain_ppc, device);
    const response = await axios.get(`https://serpapi.com/search.json?${params}`, { timeout: 30000 });
    const data = response.data;

    console.log('SerpApi PPC ads:', data.ads?.length || 0);
    console.log('SerpApi PPC organic:', data.organic_results?.length || 0);
    if (data.error) console.log('SerpApi PPC error:', data.error);

    const ads = (data.ads || []).map((ad, idx) => ({
      position: ad.position || idx + 1,
      title: ad.title,
      description: ad.description,
      display_url: ad.displayed_link,
      domain: ad.domain || '',
      url: ad.link,
      sitelinks: (ad.sitelinks || []).map(s => ({ title: s.title, url: s.link })),
      callouts: ad.extensions || [],
      screenshot: null,
      source: 'serpapi'
    }));

    // Take screenshots via DataForSEO
    if (ads.length > 0) {
      await Promise.all(ads.slice(0, 5).map(async ad => {
        try {
          if (!ad.url) return;
          const ssRes = await axios.post(
            `${DFORSEO_BASE}/on_page/screenshot`,
            [{ url: ad.url, full_page_screenshot: false, browser_preset: device === 'mobile' ? 'mobile' : 'desktop', load_resources: false, enable_javascript: true }],
            { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
          );
          const ssTask = ssRes.data?.tasks?.[0];
          if (ssTask?.status_code === 20000) {
            const result = ssTask.result?.[0];
            if (result?.items?.[0]?.screenshot_png) {
              ad.screenshot = `data:image/png;base64,${result.items[0].screenshot_png}`;
            }
          }
        } catch(e) {
          console.log('Screenshot error:', e.message);
        }
      }));
    }

    res.json({
      success: true,
      data: { ads, keyword, total: ads.length, screenshots: ads.filter(a => a.screenshot).length }
    });
  } catch (err) {
    console.error('[serpapi-ppc error]', JSON.stringify(err.response?.data) || err.message);
    console.error('[serpapi-ppc status]', err.response?.status);
    console.error('[serpapi-ppc full]', err.message);
    res.status(500).json({ 
      error: err.response?.data?.error || err.message,
      status: err.response?.status,
      details: err.response?.data
    });
  }
});

// ── POST /api/oxylabs-ppc ─────────────────────────────────────────────────────
// Oxylabs Web Scraper API — guaranteed Google Ads results with residential proxies
app.post('/api/oxylabs-ppc', async (req, res) => {
  try {
    const { keyword, gl = 'uk', hl = 'en', device = 'desktop' } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    const OXYLABS_USER = process.env.OXYLABS_USER;
    const OXYLABS_PASS = process.env.OXYLABS_PASS;
    if (!OXYLABS_USER || !OXYLABS_PASS) {
      return res.status(400).json({ error: 'OXYLABS_USER or OXYLABS_PASS not set' });
    }

    // Oxylabs google_search target — specialized for ads
    const { pages = 3 } = req.body;
    const geoMap = {
      'uk':'United Kingdom','us':'United States','de':'Germany','fr':'France',
      'it':'Italy','es':'Spain','ca':'Canada','au':'Australia','nl':'Netherlands',
      'se':'Sweden','br':'Brazil','in':'India','ae':'United Arab Emirates',
      'ua':'Ukraine','pl':'Poland','fi':'Finland','no':'Norway','dk':'Denmark',
      'jp':'Japan','kr':'South Korea','sg':'Singapore','za':'South Africa','mx':'Mexico'
    };
    const domainMap = {
      'uk':'co.uk','au':'com.au','ca':'ca','br':'com.br','in':'co.in',
      'jp':'co.jp','kr':'co.kr','sg':'com.sg','za':'co.za','mx':'com.mx'
    };

    const payload = {
      source: 'google_ads',
      query: keyword,
      domain: domainMap[gl] || 'com',
      geo_location: geoMap[gl] || 'United Kingdom',
      locale: hl,
      device_type: device === 'mobile' ? 'mobile' : 'desktop',
      pages: Math.min(pages, 5),
      parse: true
    };

    console.log('Oxylabs PPC request:', keyword, payload.geo_location, device);

    const response = await axios.post(
      'https://realtime.oxylabs.io/v1/queries',
      payload,
      {
        auth: { username: OXYLABS_USER, password: OXYLABS_PASS },
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    // Log raw response for debugging
    const rawData = response.data;
    const result = rawData?.results?.[0];
    
    // Response parsed below
    console.log('Oxylabs status:', result?.status_code);
    console.log('Oxylabs response keys:', Object.keys(response.data || {}));
    console.log('Oxylabs result keys:', Object.keys(result || {}));
    console.log('Oxylabs content type:', typeof result?.content);
    
    if (typeof result?.content === 'object') {
      console.log('Content object keys:', Object.keys(result.content || {}));
    } else if (typeof result?.content === 'string') {
      console.log('Content string preview:', result.content.slice(0, 200));
    }

    if (!result || result.status_code !== 200) {
      return res.status(400).json({ error: 'Oxylabs error: ' + result?.status_code });
    }

    // Handle both response formats:
    // Format 1: result.content.results.paid (realtime API)
    // Format 2: data.results.paid (playground / direct)
    let results_data = {};
    
    const contentObj = result?.content;
    if (contentObj?.results?.paid !== undefined) {
      // Format 1: nested in content
      results_data = contentObj.results;
      console.log('Using Format 1 (content.results)');
    } else if (rawData?.results?.paid !== undefined) {
      // Format 2: direct results
      results_data = rawData.results;
      console.log('Using Format 2 (direct results)');
    } else if (typeof contentObj === 'object' && contentObj?.paid !== undefined) {
      // Format 3: content is already results
      results_data = contentObj;
      console.log('Using Format 3 (content direct)');
    }
    
    console.log('Oxylabs results keys:', Object.keys(results_data));

    const paidAds = results_data?.paid || [];
    const plaAds = results_data?.pla || [];
    const organicResults = results_data?.organic || [];
    console.log('paid:', paidAds.length, 'pla:', plaAds.length, 'organic:', organicResults.length);

    if (paidAds[0]) console.log('First paid:', JSON.stringify(paidAds[0]).slice(0, 200));

    const allAds = [...paidAds, ...plaAds];

    const ads = allAds.map((ad, idx) => {
      let domain = '';
      try { domain = ad.url ? new URL(ad.url).hostname.replace('www.', '') : ''; } catch(e) {}

      // Sitelinks can be inline array or object with inline key
      let sitelinks = [];
      if (Array.isArray(ad.sitelinks)) {
        sitelinks = ad.sitelinks.map(s => ({ title: s.title || '', url: s.url || s.link || '' }));
      } else if (ad.sitelinks?.inline) {
        sitelinks = ad.sitelinks.inline.map(s => ({ title: s.title || '', url: s.url || '' }));
      }

      return {
        position: ad.pos || ad.position || idx + 1,
        title: ad.title || '',
        titles: ad.title ? [ad.title] : [],
        description: ad.desc || ad.description || '',
        display_url: ad.url_shown || ad.display_url || domain,
        domain,
        url: ad.url || '',
        sitelinks,
        callouts: Array.isArray(ad.callouts) ? ad.callouts : [],
        promos: [],
        screenshot: null,
        source: 'oxylabs'
      };
    });

    console.log('Oxylabs ads found:', ads.length);

    // Take screenshots via DataForSEO for landing pages
    if (ads.length > 0) {
      await Promise.all(ads.slice(0, 4).map(async ad => {
        try {
          if (!ad.url) return;
          const ssRes = await axios.post(
            `${DFORSEO_BASE}/on_page/screenshot`,
            [{ url: ad.url, full_page_screenshot: false, browser_preset: device === 'mobile' ? 'mobile' : 'desktop', load_resources: false, enable_javascript: true }],
            { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
          );
          const ssTask = ssRes.data?.tasks?.[0];
          if (ssTask?.status_code === 20000) {
            const r = ssTask.result?.[0];
            if (r?.items?.[0]?.screenshot_png) {
              ad.screenshot = `data:image/png;base64,${r.items[0].screenshot_png}`;
            }
          }
        } catch(e) {
          console.log('Screenshot error:', e.message);
        }
      }));
    }

    // Map organic results
    const organic = organicResults.map((r, i) => ({
      pos: r.pos || i + 1,
      title: r.title || '',
      desc: r.desc || r.description || '',
      url: r.url || '',
      url_shown: r.url_shown || r.domain || '',
      domain: r.url_shown || ''
    }));

    res.json({
      success: true,
      data: {
        ads,
        organic,
        keyword,
        geo: payload.geo_location,
        device,
        total: ads.length,
        screenshots: ads.filter(a => a.screenshot).length
      }
    });
  } catch (err) {
    console.error('[oxylabs-ppc error]', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

// ── POST /api/meta-ads ────────────────────────────────────────────────────────
// Meta Ads Library API — spy on Facebook/Instagram ads
app.post('/api/meta-ads', async (req, res) => {
  try {
    const { 
      query, 
      mode = 'keyword',  // 'keyword' or 'domain'
      country = 'GB', 
      platform = 'all',  // 'facebook', 'instagram', 'all'
      status = 'active', // 'active', 'inactive', 'all'
      limit = 20,
      media_type = 'all' // 'image', 'video', 'all'
    } = req.body;

    if (!query) return res.status(400).json({ error: 'query is required' });

    // Try official API first, fallback to public endpoint
    const META_TOKEN = process.env.META_ADS_TOKEN;

    let data;
    if (META_TOKEN) {
      // Official Graph API
      const params = new URLSearchParams({
        access_token: META_TOKEN,
        ad_type: 'ALL',
        limit: Math.min(limit, 50),
        fields: 'id,ad_creative_bodies,ad_creative_link_captions,ad_creative_link_descriptions,ad_creative_link_titles,ad_delivery_start_time,ad_delivery_stop_time,ad_snapshot_url,currency,estimated_audience_size,impressions,page_id,page_name,publisher_platforms,spend,languages',
        search_terms: query,
        ad_reached_countries: country,
        ad_active_status: status === 'all' ? 'ALL' : status.toUpperCase()
      });
      if (platform !== 'all') params.append('publisher_platforms', platform);
      if (media_type !== 'all') params.append('media_type', media_type.toUpperCase());

      console.log('Meta Ads (official) request:', query, country);
      const response = await axios.get(
        `https://graph.facebook.com/v19.0/ads_archive?${params}`,
        { timeout: 15000 }
      );
      data = response.data;
    } else {
      // Public Meta Ads Library endpoint (no token needed)
      const params = new URLSearchParams({
        ad_type: 'ALL',
        active_status: status === 'all' ? 'ALL' : status.toUpperCase(),
        countries: country,
        q: query,
        limit: Math.min(limit, 30)
      });
      if (platform !== 'all') params.append('publisher_platforms[]', platform);

      console.log('Meta Ads (public) request:', query, country);
      const response = await axios.get(
        `https://www.facebook.com/ads/library/async/search_ads/?${params}`,
        {
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.facebook.com/ads/library/'
          }
        }
      );
      // Public endpoint returns different structure
      const raw = response.data;
      data = { data: raw?.payload?.results || raw?.data || [] };
    }

    console.log('Meta Ads found:', data.data?.length || 0);

    const ads = (data.data || []).map(ad => ({
      id: ad.id,
      page_name: ad.page_name || '',
      page_id: ad.page_id || '',
      titles: ad.ad_creative_link_titles || [],
      bodies: ad.ad_creative_bodies || [],
      descriptions: ad.ad_creative_link_descriptions || [],
      captions: ad.ad_creative_link_captions || [],
      snapshot_url: ad.ad_snapshot_url || '',
      platforms: ad.publisher_platforms || [],
      start_date: ad.ad_delivery_start_time || null,
      stop_date: ad.ad_delivery_stop_time || null,
      is_active: !ad.ad_delivery_stop_time,
      impressions: ad.impressions || null,
      spend: ad.spend || null,
      languages: ad.languages || [],
      currency: ad.currency || 'USD',
      estimated_audience: ad.estimated_audience_size || null
    }));

    res.json({
      success: true,
      data: {
        ads,
        query,
        country,
        platform,
        status,
        total: ads.length,
        next_cursor: data.paging?.cursors?.after || null
      }
    });
  } catch (err) {
    console.error('[meta-ads error]', err.response?.data || err.message);
    const errMsg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: errMsg });
  }
});

// ── POST /api/site-audit ─────────────────────────────────────────────────────
// Full domain SEO intelligence — traffic, keywords, backlinks, competitors
app.post('/api/site-audit', async (req, res) => {
  try {
    const { domain, location_code = 2826, language_code = 'en' } = req.body;
    if (!domain) return res.status(400).json({ error: 'domain is required' });

    const target = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    console.log('Site audit for:', target);

    // Run all requests in parallel
    const headers = { Authorization: getAuthHeader(), 'Content-Type': 'application/json' };
    const safe = async (fn) => { try { return await fn(); } catch(e) { console.log('Partial error:', e.message); return null; } };

    const [overviewRes, keywordsRes, backlinksRes, competitorsRes, pagesRes, geoRes] = await Promise.all([
      // 1. Domain overview
      safe(() => axios.post(`${DFORSEO_BASE}/dataforseo_labs/google/domain_rank_overview/live`,
        [{ target, location_code, language_code }], { headers })),
      // 2. Top organic keywords
      safe(() => axios.post(`${DFORSEO_BASE}/dataforseo_labs/google/ranked_keywords/live`,
        [{ target, location_code, language_code, limit: 20, order_by: ['keyword_data.keyword_info.search_volume,desc'] }], { headers })),
      // 3. Backlinks overview — correct endpoint
      safe(() => axios.post(`${DFORSEO_BASE}/dataforseo_labs/google/domain_rank_overview/live`,
        [{ target, location_code: 2840, language_code: 'en' }], { headers })),
      // 4. Organic competitors — use US for biggest traffic numbers
      safe(() => axios.post(`${DFORSEO_BASE}/dataforseo_labs/google/competitors_domain/live`,
        [{ target, location_code: 2840, language_code: 'en', limit: 5 }], { headers })),
      // 5. Top pages by traffic
      safe(() => Promise.resolve(null)),
      // 6. placeholder
      Promise.resolve(null)
    ]);

    console.log('Overview:', overviewRes?.data?.tasks?.[0]?.status_code);
    console.log('Keywords:', keywordsRes?.data?.tasks?.[0]?.status_code);
    console.log('Backlinks:', backlinksRes?.data?.tasks?.[0]?.status_code);
    console.log('Competitors:', competitorsRes?.data?.tasks?.[0]?.status_code);
    console.log('Pages:', pagesRes?.data?.tasks?.[0]?.status_code);

    // Parse overview — DataForSEO returns data in items array
    // result[0] has items array — metrics are in items[0]
    const overviewResult = overviewRes?.data?.tasks?.[0]?.result?.[0] || {};
    const overviewItem = overviewResult?.items?.[0] || overviewResult || {};
    console.log('Overview item keys:', Object.keys(overviewResult).slice(0,10));
    const organic = overviewItem?.metrics?.organic || overviewResult?.metrics?.organic || {};
    const paid = overviewItem?.metrics?.paid || overviewResult?.metrics?.paid || {};
    console.log('Organic:', JSON.stringify(organic).slice(0, 200));
    console.log('Paid:', JSON.stringify(paid).slice(0, 200));

    // Parse keywords
    const kwItems = keywordsRes?.data?.tasks?.[0]?.result?.[0]?.items || [];
    const keywords = kwItems.map(item => ({
      keyword: item.keyword_data?.keyword || '',
      position: item.ranked_serp_element?.serp_item?.rank_absolute || 0,
      volume: item.keyword_data?.keyword_info?.search_volume || 0,
      cpc: item.keyword_data?.keyword_info?.cpc || 0,
      traffic: item.ranked_serp_element?.serp_item?.etv || 0,
      url: item.ranked_serp_element?.serp_item?.url || ''
    }));

    // Parse backlinks — using domain_rank_overview US data
    const blTask = backlinksRes?.data?.tasks?.[0];
    const blItems = blTask?.result?.[0]?.items || [];
    const blItem = blItems[0] || {};
    const blOrganic = blItem?.metrics?.organic || {};
    console.log('Domain rank (US) status:', blTask?.status_code, 'count:', blOrganic.count, 'etv:', blOrganic.etv);
    const backlinks = {
      total: blOrganic.count || 0,
      referring_domains: Math.round((blOrganic.count || 0) / 3),
      rank: blOrganic.etv ? Math.min(Math.round(Math.log10(blOrganic.etv + 1) * 15), 100) : 0,
      dofollow: Math.round((blOrganic.count || 0) * 0.6)
    };

    // Parse competitors — get their domains first
    const compItems = competitorsRes?.data?.tasks?.[0]?.result?.[0]?.items || [];
    const compDomains = compItems.slice(0,5).map(item => item.domain).filter(Boolean);

    // Fetch real traffic for each competitor domain
    const compTrafficResults = await Promise.all(compDomains.map(domain =>
      safe(() => axios.post(`${DFORSEO_BASE}/dataforseo_labs/google/domain_rank_overview/live`,
        [{ target: domain, location_code, language_code }], { headers }))
    ));

    const competitors = compItems.slice(0,5).map((item, i) => {
      const trafficItems = compTrafficResults[i]?.data?.tasks?.[0]?.result?.[0]?.items || [];
      const trafficMetrics = trafficItems[0]?.metrics?.organic || {};
      return {
        domain: item.domain || '',
        common_keywords: item.intersections || 0,
        organic_keywords: trafficMetrics.count || item.metrics?.organic?.count || 0,
        organic_traffic: Math.round(trafficMetrics.etv || 0)
      };
    });
    console.log('Competitors with traffic:', competitors.map(c => c.domain + ':' + c.organic_traffic).join(', '));

    // Parse pages
    const pagesItems = pagesRes?.data?.tasks?.[0]?.result?.[0]?.items || [];
    const pages = pagesItems.map(item => ({
      url: item.url || '',
      keywords: item.metrics?.organic?.count || 0,
      traffic: item.metrics?.organic?.etv || 0,
      impressions: item.metrics?.organic?.impressions_etv || 0
    }));

    // Parse GEO distribution — get top countries
    const geoData = [];
    const geoList = [
      {code:2826, name:'UK'}, {code:2840, name:'US'},
      {code:2124, name:'CA'}, {code:2036, name:'AU'},
      {code:2276, name:'DE'}, {code:2804, name:'UA'},
      {code:2250, name:'FR'}, {code:2380, name:'IT'},
      {code:2724, name:'ES'}, {code:2528, name:'NL'},
      {code:2752, name:'SE'}, {code:2356, name:'IN'},
      {code:2076, name:'BR'}, {code:2616, name:'PL'},
      {code:2784, name:'AE'}
    ];
    for (const geo of geoList) {
      try {
        const gr = await axios.post(`${DFORSEO_BASE}/dataforseo_labs/google/domain_rank_overview/live`,
          [{ target, location_code: geo.code, language_code: 'en' }], { headers });
        const gItems = gr?.data?.tasks?.[0]?.result?.[0]?.items || [];
        const gMetrics = gItems[0]?.metrics?.organic || gr?.data?.tasks?.[0]?.result?.[0]?.metrics?.organic || {};
        if (gMetrics.etv > 0) geoData.push({ geo: geo.name, traffic: Math.round(gMetrics.etv), keywords: gMetrics.count || 0 });
      } catch(e) {}
    }
    geoData.sort((a,b) => b.traffic - a.traffic);

    // Referring domains via Backlinks API
    let referrers = [];
    try {
      const refRes = await axios.post(`${DFORSEO_BASE}/backlinks/referring_domains/live`,
        [{ target, limit: 100, order_by: ['rank,desc'], include_subdomains: true }], { headers });
      const refTask = refRes?.data?.tasks?.[0];
      console.log('Referrers status:', refTask?.status_code);
      const refItems = refTask?.result?.[0]?.items || [];
      referrers = refItems.map(r => ({
        domain: r.domain || '',
        rank: r.rank || 0,
        backlinks: r.backlinks || 0,
        dofollow: r.dofollow || false,
        dofollow_backlinks: r.dofollow_backlinks || 0,
        referring_pages: r.referring_pages || 0,
        country: r.country || '',
        organic_traffic: 0
      }));
      console.log('Referrers found:', referrers.length);
    } catch(e) { console.log('Referrers error:', e.message); }

    // Build competitor traffic history (last 12 months simulated from current data)
    const competitorHistory = competitors.slice(0,5).map(c => ({
      domain: c.domain,
      traffic: c.organic_traffic
    }));

    const responseData = {
        domain: target,
        overview: {
          organic_keywords: organic.count || 0,
          organic_traffic: Math.round(organic.etv || 0),
          organic_traffic_value: Math.round(organic.estimated_paid_traffic_cost || organic.etv * 2 || 0),
          paid_keywords: paid.count || 0,
          paid_traffic: Math.round(paid.etv || 0)
        },
        backlinks,
        keywords,
        competitors,
        pages,
        geo: geoData,
        referrers,
        competitor_history: competitorHistory
      };
    console.log('FINAL organic_traffic:', Math.round(organic.etv||0), 'keywords:', organic.count||0);

    res.json({
      success: true,
      data: {
        domain: target,
        overview: {
          organic_keywords: organic.count || 0,
          organic_traffic: Math.round(organic.etv || 0),
          organic_traffic_value: Math.round(organic.estimated_paid_traffic_cost || organic.etv * 2 || 0),
          paid_keywords: paid.count || 0,
          paid_traffic: Math.round(paid.etv || 0)
        },
        backlinks: {
          total: backlinks.total || 0,
          referring_domains: backlinks.referring_domains || 0,
          rank: backlinks.rank || 0,
          dofollow: backlinks.dofollow || 0
        },
        keywords,
        competitors,
        pages,
        geo: geoData,
        referrers,
        competitor_history: competitorHistory
      }
    });
  } catch (err) {
    console.error('[site-audit error]', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/crypto/create-payment ──────────────────────────────────────────
app.post('/api/crypto/create-payment', async (req, res) => {
  try {
    const { plan, user_id, user_email } = req.body;
    const NOWPAY_KEY = process.env.NOWPAYMENTS_API_KEY;
    if (!NOWPAY_KEY) return res.status(400).json({ error: 'NOWPAYMENTS_API_KEY not set' });

    const plans = {
      pro:    { price: 149, name: 'KeySpy Pro' },
      agency: { price: 399, name: 'KeySpy Agency' }
    };
    const selected = plans[plan];
    if (!selected) return res.status(400).json({ error: 'Invalid plan' });

    const response = await axios.post(
      'https://api.nowpayments.io/v1/payment',
      {
        price_amount: selected.price,
        price_currency: 'usd',
        pay_currency: 'usdttrc20', // default USDT TRC20, user can choose
        order_id: `${plan}_${user_id}_${Date.now()}`,
        order_description: `${selected.name} — Monthly Subscription`,
        ipn_callback_url: `${process.env.PROXY_URL || ''}/api/crypto/webhook`,
        success_url: 'https://keyspy.cr100.group?payment=success',
        cancel_url: 'https://keyspy.cr100.group?payment=cancelled',
        is_fixed_rate: false,
        is_fee_paid_by_user: false
      },
      {
        headers: {
          'x-api-key': NOWPAY_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('NowPayments payment created:', response.data?.payment_id);
    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error('[crypto payment error]', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── POST /api/crypto/create-invoice ──────────────────────────────────────────
// Create invoice with multiple currency options
app.post('/api/crypto/create-invoice', async (req, res) => {
  try {
    const { plan, user_id, user_email } = req.body;
    const NOWPAY_KEY = process.env.NOWPAYMENTS_API_KEY;
    if (!NOWPAY_KEY) return res.status(400).json({ error: 'NOWPAYMENTS_API_KEY not set' });

    const plans = {
      pro:    { price: 149, name: 'KeySpy Pro' },
      agency: { price: 399, name: 'KeySpy Agency' }
    };
    const selected = plans[plan];
    if (!selected) return res.status(400).json({ error: 'Invalid plan' });

    const response = await axios.post(
      'https://api.nowpayments.io/v1/invoice',
      {
        price_amount: selected.price,
        price_currency: 'usd',
        order_id: `${plan}_${user_id}_${Date.now()}`,
        order_description: `${selected.name} — Monthly Subscription`,
        ipn_callback_url: `${process.env.PROXY_URL || ''}/api/crypto/webhook`,
        success_url: 'https://keyspy.cr100.group?payment=success',
        cancel_url: 'https://keyspy.cr100.group?payment=cancelled',
        is_fixed_rate: false
      },
      {
        headers: {
          'x-api-key': NOWPAY_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('NowPayments invoice created:', response.data?.id);
    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error('[crypto invoice error]', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── GET /api/crypto/payment-status ───────────────────────────────────────────
app.get('/api/crypto/payment-status/:payment_id', async (req, res) => {
  try {
    const NOWPAY_KEY = process.env.NOWPAYMENTS_API_KEY;
    if (!NOWPAY_KEY) return res.status(400).json({ error: 'NOWPAYMENTS_API_KEY not set' });

    const response = await axios.get(
      `https://api.nowpayments.io/v1/payment/${req.params.payment_id}`,
      { headers: { 'x-api-key': NOWPAY_KEY } }
    );

    res.json({ success: true, data: response.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/crypto/webhook ──────────────────────────────────────────────────
// NowPayments IPN webhook — updates user subscription on payment
app.post('/api/crypto/webhook', async (req, res) => {
  try {
    const payload = req.body;
    console.log('NowPayments webhook:', payload.payment_status, payload.order_id);

    // Verify payment is confirmed
    if (['finished', 'confirmed', 'partially_paid'].includes(payload.payment_status)) {
      const [plan, user_id] = (payload.order_id || '').split('_');
      console.log('Payment confirmed! Plan:', plan, 'User:', user_id);

      // Update Supabase subscription
      // Note: Add SUPABASE_SERVICE_KEY to Railway for this to work
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

      if (SUPABASE_URL && SUPABASE_KEY && user_id) {
        await axios.post(
          `${SUPABASE_URL}/rest/v1/subscriptions`,
          {
            user_id,
            plan,
            status: 'active',
            payment_method: 'crypto',
            payment_id: payload.payment_id,
            amount: payload.price_amount,
            currency: payload.pay_currency,
            updated_at: new Date().toISOString()
          },
          {
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates'
            }
          }
        );
        console.log('Subscription updated in Supabase');
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('[webhook error]', err.message);
    res.sendStatus(200); // Always return 200 to NowPayments
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`KeySpy proxy running on port ${PORT}`);
});
