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

app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.post('/api/keywords', async (req, res) => {
  try {
    const { keyword, location_code = 2826, language_code = 'en' } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    const response = await axios.post(
      `${DFORSEO_BASE}/keywords_data/google_ads/search_volume/live`,
      [{ keywords: [keyword], location_code, language_code }],
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
    );

    // Log full response for debugging
    const task = response.data?.tasks?.[0];
    console.log('Task status:', task?.status_code, task?.status_message);
    console.log('Result count:', task?.result?.length);

    if (!task || task.status_code !== 20000) {
      return res.status(400).json({ error: task?.status_message || 'DataForSEO error', status_code: task?.status_code });
    }

    // search_volume returns flat array of results
    const results = (task.result || []).map(item => ({
      keyword: item.keyword,
      volume: item.search_volume || 0,
      cpc: item.cpc || 0,
      competition: item.competition || 0,
      competition_level: item.competition_level || 'UNKNOWN',
      trend: item.monthly_searches ? getTrend(item.monthly_searches) : 'stable'
    }));

    console.log('Returning results:', results.length);
    res.json({ success: true, data: results });

  } catch (err) {
    console.error('[keywords error]', err.response?.data || err.message);
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`KeySpy proxy running on port ${PORT}`);
});
