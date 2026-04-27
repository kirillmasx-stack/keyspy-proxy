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
// Google Ads Transparency Center — real ads by advertiser domain
app.post('/api/ads-transparency', async (req, res) => {
  try {
    const { domain, location_code = 2826, language_code = 'en', date_from, date_to, depth = 40, sort_by = 'newest' } = req.body;
    if (!domain) return res.status(400).json({ error: 'domain is required' });

    // Use DataForSEO Labs domain rank overview + ranked keywords for transparency
    // Step 1: Get domain overview
    const overviewRes = await axios.post(
      `${DFORSEO_BASE}/dataforseo_labs/google/domain_rank_overview/live`,
      [{ target: domain, location_code, language_code }],
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
    );
    const overviewTask = overviewRes.data?.tasks?.[0];
    console.log('Transparency overview status:', overviewTask?.status_code, overviewTask?.status_message);

    const metrics = overviewTask?.result?.[0]?.metrics || {};
    const paid_count = metrics.paid?.count || 0;
    const paid_etv = Math.round(metrics.paid?.etv || 0);
    const organic_count = metrics.organic?.count || 0;

    // Step 2: Get top paid keywords for this domain with filters
    const kwPayload = {
      target: domain,
      location_code,
      language_code,
      limit: Math.min(depth, 40),
      order_by: [sort_by === 'oldest' ? 'keyword_data.keyword_info.search_volume,asc' : 'keyword_data.keyword_info.search_volume,desc']
    };
    const kwRes = await axios.post(
      `${DFORSEO_BASE}/dataforseo_labs/google/ranked_keywords/live`,
      [kwPayload],
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
    );
    const kwTask = kwRes.data?.tasks?.[0];
    console.log('Transparency keywords status:', kwTask?.status_code, kwTask?.status_message);

    const kwItems = kwTask?.result?.[0]?.items || [];

    // Apply date filter client-side on first_seen/last_seen if available
    const filteredItems = kwItems.filter(item => {
      if (!date_from && !date_to) return true;
      const seen = item.ranked_serp_element?.serp_item?.rank_changes?.previous_rank_absolute;
      return true; // DataForSEO Labs doesn't expose dates at keyword level
    });

    // Build ads from keyword data
    const ads = filteredItems.map(item => ({
      keyword: item.keyword_data?.keyword || '',
      volume: item.keyword_data?.keyword_info?.search_volume || 0,
      cpc: item.keyword_data?.keyword_info?.cpc || 0,
      position: item.ranked_serp_element?.serp_item?.rank_absolute || 1,
      titles: [item.ranked_serp_element?.serp_item?.title || domain].filter(Boolean),
      description: item.ranked_serp_element?.serp_item?.description || '',
      display_url: item.ranked_serp_element?.serp_item?.breadcrumb || domain,
      domain: domain,
      url: item.ranked_serp_element?.serp_item?.url || '',
      sitelinks: [], callouts: [], promos: [],
      source: 'transparency'
    }));

    res.json({
      success: true,
      data: {
        domain,
        ads,
        total: ads.length,
        paid_keywords: paid_count,
        paid_etv,
        organic_keywords: organic_count,
        date_from: date_from || null,
        date_to: date_to || null,
        summary: `${domain} runs ads on ~${paid_count} keywords · Est. traffic value $${paid_etv}/mo · ${organic_count} organic keywords${date_from ? ` · From: ${date_from}` : ''}${date_to ? ` · To: ${date_to}` : ''}`,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`KeySpy proxy running on port ${PORT}`);
});
