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
      `${DFORSEO_BASE}/serp/google/ads/live/advanced`,
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

    // Run organic + paid requests in parallel
    const [organicRes, paidRes] = await Promise.all([
      axios.post(
        `${DFORSEO_BASE}/serp/google/organic/live/advanced`,
        [{ keyword, location_code, language_code, device, os: device === 'mobile' ? 'android' : 'windows', depth }],
        { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
      ),
      axios.post(
        `${DFORSEO_BASE}/serp/google/ads/live/advanced`,
        [{ keyword, location_code, language_code, device, os: device === 'mobile' ? 'android' : 'windows', depth: 10 }],
        { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
      )
    ]);

    const task = organicRes.data?.tasks?.[0];
    const paidTask = paidRes.data?.tasks?.[0];
    console.log('SERP organic status:', task?.status_code, task?.status_message);
    console.log('SERP paid status:', paidTask?.status_code, paidTask?.status_message);
    if (!task || task.status_code !== 20000) {
      return res.status(400).json({ error: task?.status_message || 'DataForSEO error' });
    }

    const items = task.result?.[0]?.items || [];
    // Add paid items from separate ads endpoint
    const paidItems = paidTask?.result?.[0]?.items || [];
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

    // Process paid ads from dedicated ads endpoint
    paidItems.filter(i => i.type === 'paid').forEach(item => {
      if (!paid.find(p => p.domain === item.domain)) {
        paid.push({
          rank: item.rank_absolute,
          title: item.title,
          url: item.url,
          domain: item.domain,
          description: item.description,
          breadcrumb: item.breadcrumb
        });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`KeySpy proxy running on port ${PORT}`);
});
