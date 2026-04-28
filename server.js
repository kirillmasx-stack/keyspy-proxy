const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
    const { keyword, location_code = 2826, language_code = 'en' } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    // Generate 50 keyword variations to bulk check volumes
    const variations = generateVariations(keyword);
    console.log(`Checking ${variations.length} keyword variations for: ${keyword}`);

    const response = await axios.post(
      `${DFORSEO_BASE}/keywords_data/google_ads/search_volume/live`,
      [{ keywords: variations, location_code, language_code }],
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
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
        // competition comes as string: "LOW"/"MEDIUM"/"HIGH"
        const compStr = (item.competition || '').toUpperCase();
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
    const { keyword, location_code = 2826, language_code = 'en', device = 'desktop', depth = 100 } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    // Use regular endpoint - returns both organic + paid results together
    const organicRes = await axios.post(
      `${DFORSEO_BASE}/serp/google/organic/live/regular`,
      [{ keyword, location_code, language_code, device, os: device === 'mobile' ? 'android' : 'windows', depth }],
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
    const payload = {
      source: 'google_ads',
      query: keyword,
      domain: gl === 'uk' ? 'co.uk' : gl === 'au' ? 'com.au' : gl === 'ca' ? 'ca' : 'com',
      geo_location: gl === 'uk' ? 'United Kingdom' : gl === 'us' ? 'United States' :
                    gl === 'de' ? 'Germany' : gl === 'fr' ? 'France' :
                    gl === 'it' ? 'Italy' : gl === 'es' ? 'Spain' :
                    gl === 'ca' ? 'Canada' : gl === 'au' ? 'Australia' :
                    gl === 'nl' ? 'Netherlands' : gl === 'se' ? 'Sweden' :
                    gl === 'br' ? 'Brazil' : gl === 'in' ? 'India' :
                    gl === 'ae' ? 'United Arab Emirates' : gl === 'ua' ? 'Ukraine' : 'United Kingdom',
      locale: hl,
      device_type: device === 'mobile' ? 'mobile' : 'desktop',
      pages: 1,
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
    
    // Try to get paid from multiple paths
    const contentObj = result?.content;
    const directPaid = contentObj?.results?.paid;
    console.log('Direct paid path length:', directPaid?.length || 0);
    console.log('Full content sample:', JSON.stringify(contentObj?.results?.paid?.slice(0,1) || 'empty'));
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
    console.log('paid:', paidAds.length, 'pla:', plaAds.length);

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

    res.json({
      success: true,
      data: {
        ads,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`KeySpy proxy running on port ${PORT}`);
});
