const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Fix CORS — allow all origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const DFORSEO_BASE = 'https://api.dataforseo.com/v3';

function getAuthHeader() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) throw new Error('DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD not set');
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

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.post('/api/keywords', async (req, res) => {
  try {
    const { keyword, location_code = 2826, language_code = 'en' } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });
    const payload = [{ keywords: [keyword], location_code, language_code }];
    const response = await axios.post(
      `${DFORSEO_BASE}/keywords_data/google_ads/search_volume/live`,
      payload,
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
    );
    const task = response.data?.tasks?.[0];
    if (!task || task.status_code !== 20000) {
      return res.status(400).json({ error: task?.status_message || 'DataForSEO error' });
    }
    const results = (task.result || []).map(item => ({
      keyword: item.keyword,
      volume: item.search_volume || 0,
      cpc: item.cpc || 0,
      competition: item.competition || 0,
      competition_level: item.competition_level || 'UNKNOWN',
      trend: item.monthly_searches ? getTrend(item.monthly_searches) : 'stable'
    }));
    res.json({ success: true, data: results });
  } catch (err) {
    console.error('[/api/keywords]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/serp-ads', async (req, res) => {
  try {
    const { keyword, location_code = 2826, language_code = 'en', device = 'desktop' } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });
    const payload = [{ keyword, location_code, language_code, device, os: device === 'mobile' ? 'android' : 'windows', depth: 10 }];
    const response = await axios.post(
      `${DFORSEO_BASE}/serp/google/ads/live/advanced`,
      payload,
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
    );
    const task = response.data?.tasks?.[0];
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
    console.error('[/api/serp-ads]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/volume', async (req, res) => {
  try {
    const { keywords, location_code = 2826, language_code = 'en' } = req.body;
    if (!keywords?.length) return res.status(400).json({ error: 'keywords array required' });
    const payload = [{ keywords, location_code, language_code }];
    const response = await axios.post(
      `${DFORSEO_BASE}/keywords_data/google_ads/search_volume/live`,
      payload,
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
    );
    const task = response.data?.tasks?.[0];
    if (!task || task.status_code !== 20000) return res.status(400).json({ error: task?.status_message });
    const results = (task.result || []).map(item => ({
      keyword: item.keyword, volume: item.search_volume || 0,
      cpc: item.cpc || 0, competition: item.competition || 0,
      trend: item.monthly_searches ? getTrend(item.monthly_searches) : 'stable'
    }));
    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`KeySpy proxy running on port ${PORT}`));
