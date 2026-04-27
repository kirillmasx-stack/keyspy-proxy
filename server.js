// KeySpy — DataForSEO Proxy Server
// Deploy to: Railway, Render, Heroku, or any Node.js host
//
// 1. npm install
// 2. Set env vars: DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
// 3. node server.js

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*' // Set to your frontend domain in production
}));

const DFORSEO_BASE = 'https://api.dataforseo.com/v3';

// Auth header builder
function getAuthHeader() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) throw new Error('DataForSEO credentials not set in env vars');
  return 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
}

// ─── ENDPOINT 1: Keyword Research ───────────────────────────────────────────
// POST /api/keywords
// Body: { keyword, location_code, language_code }
// Returns: array of keyword ideas with volume, CPC, competition
app.post('/api/keywords', async (req, res) => {
  try {
    const { keyword, location_code = 2826, language_code = 'en' } = req.body;
    // location_code 2826 = United Kingdom
    // Full list: https://api.dataforseo.com/v3/keywords_data/google/locations

    const payload = [{
      keyword,
      location_code,
      language_code,
      include_seed_keyword: true,
      include_adult_keywords: false,
      limit: 20
    }];

    const response = await axios.post(
      `${DFORSEO_BASE}/keywords_data/google_ads/keywords_for_keywords/live`,
      payload,
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
    );

    const task = response.data?.tasks?.[0];
    if (task?.status_code !== 20000) {
      return res.status(400).json({ error: task?.status_message || 'DataForSEO error' });
    }

    const results = (task.result || []).map(item => ({
      keyword: item.keyword,
      volume: item.search_volume,
      cpc: item.cpc,
      competition: item.competition, // 0–1
      competition_level: item.competition_level, // LOW / MEDIUM / HIGH
      trend: item.monthly_searches ? getTrend(item.monthly_searches) : 'stable'
    }));

    res.json({ success: true, data: results });
  } catch (err) {
    console.error('Keywords error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ENDPOINT 2: SERP / Ad Copy Analysis ────────────────────────────────────
// POST /api/serp-ads
// Body: { keyword, location_code, language_code, device }
// Returns: paid ads (Google Ads) from SERP
app.post('/api/serp-ads', async (req, res) => {
  try {
    const {
      keyword,
      location_code = 2826,
      language_code = 'en',
      device = 'desktop'
    } = req.body;

    const payload = [{
      keyword,
      location_code,
      language_code,
      device,
      os: device === 'mobile' ? 'android' : 'windows',
      depth: 10 // number of results
    }];

    const response = await axios.post(
      `${DFORSEO_BASE}/serp/google/ads/live/advanced`,
      payload,
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
    );

    const task = response.data?.tasks?.[0];
    if (task?.status_code !== 20000) {
      return res.status(400).json({ error: task?.status_message || 'DataForSEO error' });
    }

    // Extract paid ads from SERP items
    const items = task.result?.[0]?.items || [];
    const ads = items
      .filter(item => item.type === 'paid')
      .map((item, index) => ({
        position: item.rank_absolute || index + 1,
        domain: item.domain,
        title: item.title,
        description: item.description,
        display_url: item.breadcrumb || item.url,
        headlines: item.extended_snippet?.title_lines || [],
        descriptions: item.extended_snippet?.description_lines || [],
        sitelinks: (item.sitelinks || []).map(s => ({ title: s.title, description: s.description }))
      }));

    res.json({ success: true, data: ads, keyword, location_code });
  } catch (err) {
    console.error('SERP ads error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ENDPOINT 3: Keyword Volume Bulk ────────────────────────────────────────
// POST /api/volume
// Body: { keywords: [...], location_code, language_code }
// Useful for checking volumes of your own keyword lists
app.post('/api/volume', async (req, res) => {
  try {
    const { keywords, location_code = 2826, language_code = 'en' } = req.body;
    if (!keywords?.length) return res.status(400).json({ error: 'keywords array required' });

    const payload = [{
      keywords,
      location_code,
      language_code
    }];

    const response = await axios.post(
      `${DFORSEO_BASE}/keywords_data/google_ads/search_volume/live`,
      payload,
      { headers: { Authorization: getAuthHeader(), 'Content-Type': 'application/json' } }
    );

    const task = response.data?.tasks?.[0];
    if (task?.status_code !== 20000) {
      return res.status(400).json({ error: task?.status_message });
    }

    const results = (task.result || []).map(item => ({
      keyword: item.keyword,
      volume: item.search_volume,
      cpc: item.cpc,
      competition: item.competition,
      trend: item.monthly_searches ? getTrend(item.monthly_searches) : 'stable'
    }));

    res.json({ success: true, data: results });
  } catch (err) {
    console.error('Volume error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ENDPOINT 4: Available Locations ────────────────────────────────────────
app.get('/api/locations', async (req, res) => {
  try {
    const response = await axios.get(
      `${DFORSEO_BASE}/keywords_data/google_ads/locations`,
      { headers: { Authorization: getAuthHeader() } }
    );
    const locations = response.data?.tasks?.[0]?.result || [];
    // Return only country-level
    const countries = locations
      .filter(l => l.location_type === 'Country')
      .map(l => ({ name: l.location_name, code: l.location_code, country: l.country_iso_code }));
    res.json({ success: true, data: countries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ─── Helper: detect trend from monthly_searches array ───────────────────────
function getTrend(monthly) {
  if (!monthly || monthly.length < 3) return 'stable';
  const recent = monthly.slice(0, 3).reduce((s, m) => s + (m.search_volume || 0), 0) / 3;
  const older = monthly.slice(-3).reduce((s, m) => s + (m.search_volume || 0), 0) / 3;
  if (recent > older * 1.15) return 'up';
  if (recent < older * 0.85) return 'down';
  return 'stable';
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`KeySpy proxy running on port ${PORT}`));
