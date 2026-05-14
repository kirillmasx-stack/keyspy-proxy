const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ── CREDENTIALS ───────────────────────────────────────────────────────────────
const DFORSEO_LOGIN    = process.env.DATAFORSEO_LOGIN;
const DFORSEO_PASS     = process.env.DATAFORSEO_PASSWORD;
const DFORSEO_BASE     = 'https://api.dataforseo.com/v3';
const SERPAPI_KEY      = process.env.SERPAPI_KEY;
const OXYLABS_USER     = process.env.OXYLABS_USER;
const OXYLABS_PASS     = process.env.OXYLABS_PASS;
const SCRAPER_URL      = process.env.SCRAPER_URL;
const SCRAPERAPI_KEY   = process.env.SCRAPERAPI_KEY;
const NOWPAYMENTS_KEY  = process.env.NOWPAYMENTS_API_KEY;

function getAuthHeader() {
  return 'Basic ' + Buffer.from(`${DFORSEO_LOGIN}:${DFORSEO_PASS}`).toString('base64');
}

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── POST /api/keywords ────────────────────────────────────────────────────────
app.post('/api/keywords', async (req, res) => {
  try {
    const { keyword, location_code = 2826, language_code = 'en', engine = 'google' } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    const headers = { Authorization: getAuthHeader(), 'Content-Type': 'application/json' };
    const endpoint = engine === 'bing'
      ? `${DFORSEO_BASE}/keywords_data/bing/search_volume/live`
      : `${DFORSEO_BASE}/keywords_data/google_ads/search_volume/live`;

    const payload = [{ keywords: [keyword], location_code, language_code }];
    const response = await axios.post(endpoint, payload, { headers });
    const task = response.data?.tasks?.[0];

    if (task?.status_code !== 20000) {
      return res.status(400).json({ error: task?.status_message || 'DataForSEO error' });
    }

    // Also get keyword ideas
    const ideasEndpoint = engine === 'bing'
      ? `${DFORSEO_BASE}/keywords_data/bing/keywords_for_keywords/live`
      : `${DFORSEO_BASE}/keywords_data/google_ads/keywords_for_keywords/live`;

    const ideasPayload = [{ keywords: [keyword], location_code, language_code, limit: 50 }];
    const ideasRes = await axios.post(ideasEndpoint, ideasPayload, { headers }).catch(() => null);
    const ideasTask = ideasRes?.data?.tasks?.[0];

    const mainItems = task.result?.[0]?.items || [];
    const ideasItems = ideasTask?.result?.[0]?.items || [];
    const allItems = [...mainItems, ...ideasItems];

    const keywords = allItems.map(item => ({
      keyword: item.keyword,
      volume: item.search_volume || 0,
      cpc: item.cpc || 0,
      competition: item.competition || 0,
      competition_level: item.competition_level || '',
      monthly_searches: (item.monthly_searches || []).slice(0, 12).map(m => ({
        year: m.year, month: m.month, volume: m.search_volume || 0
      })),
    })).filter(k => k.keyword);

    res.json({ success: true, data: { keyword, keywords, total: keywords.length } });
  } catch(err) {
    console.error('[keywords]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/serp-organic ────────────────────────────────────────────────────
app.post('/api/serp-organic', async (req, res) => {
  try {
    const { keyword, location_code = 2826, language_code = 'en', engine = 'google', depth = 10 } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    const headers = { Authorization: getAuthHeader(), 'Content-Type': 'application/json' };
    const endpointMap = {
      google: `${DFORSEO_BASE}/serp/google/organic/live/advanced`,
      bing:   `${DFORSEO_BASE}/serp/bing/organic/live/advanced`,
      yahoo:  `${DFORSEO_BASE}/serp/yahoo/organic/live/advanced`,
      youtube:`${DFORSEO_BASE}/serp/youtube/organic/live/advanced`,
    };
    const endpoint = endpointMap[engine] || endpointMap.google;
    const payload = [{ keyword, location_code, language_code, depth: Math.min(depth, 100) }];
    const response = await axios.post(endpoint, payload, { headers });
    const task = response.data?.tasks?.[0];

    if (task?.status_code !== 20000) {
      return res.status(400).json({ error: task?.status_message || 'SERP error' });
    }

    const items = task.result?.[0]?.items || [];
    res.json({ success: true, data: { keyword, engine, items, total: items.length } });
  } catch(err) {
    console.error('[serp-organic]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/ads-analyzer ────────────────────────────────────────────────────
app.post('/api/ads-analyzer', async (req, res) => {
  try {
    const { query, location_code = 2826, language_code = 'en', device = 'desktop', mode = 'keyword', depth = 10 } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });

    const headers = { Authorization: getAuthHeader(), 'Content-Type': 'application/json' };
    let ads = [];

    if (mode === 'bing') {
      const bingRes = await axios.post(
        `${DFORSEO_BASE}/serp/bing/organic/live/advanced`,
        [{ keyword: query, location_code, language_code, device, depth: 100 }],
        { headers }
      );
      const bingTask = bingRes.data?.tasks?.[0];
      const bingItems = (bingTask?.result?.[0]?.items || []).filter(i => i.type === 'paid');
      ads = bingItems.map((item, idx) => ({
        position: item.rank_absolute || idx + 1,
        keyword: query,
        domain: item.domain || '',
        titles: item.title ? [item.title] : [],
        description: item.description || item.snippet || '',
        display_url: item.breadcrumb || item.url || '',
        url: item.url || '',
        sitelinks: (item.sitelinks || []).map(s => ({ title: s.title, description: s.description, url: s.url })),
        callouts: [], promos: [], source: 'bing'
      }));
      return res.json({ success: true, data: { keyword: query, ads, total: ads.length, engine: 'bing' } });
    }

    if (mode === 'keyword') {
      const response = await axios.post(
        `${DFORSEO_BASE}/serp/google/paid/live/advanced`,
        [{ keyword: query, location_code, language_code, device, os: device === 'mobile' ? 'android' : 'windows', depth: 10 }],
        { headers }
      );
      const task = response.data?.tasks?.[0];
      const items = (task?.result?.[0]?.items || []).filter(i => i.type === 'paid');
      ads = items.map((item, idx) => ({
        position: item.rank_absolute || idx + 1,
        keyword: query,
        domain: item.domain || '',
        titles: (item.title_lines || (item.title ? [item.title] : [])),
        description: item.description || '',
        display_url: item.breadcrumb || item.domain || '',
        url: item.url || '',
        sitelinks: (item.sitelinks || []).map(s => ({ title: s.title, description: s.description })),
        callouts: (item.callouts || []),
        promos: (item.price_extension || []),
        source: 'google'
      }));
    } else if (mode === 'domain') {
      const response = await axios.post(
        `${DFORSEO_BASE}/serp/google/paid/live/advanced`,
        [{ keyword: query, location_code, language_code, device, depth: Math.min(depth * 10, 100) }],
        { headers }
      );
      const task = response.data?.tasks?.[0];
      const items = (task?.result?.[0]?.items || []).filter(i => i.type === 'paid' && (i.domain === query || i.url?.includes(query)));
      ads = items.map((item, idx) => ({
        position: item.rank_absolute || idx + 1,
        keyword: query,
        domain: item.domain || '',
        titles: (item.title_lines || [item.title]),
        description: item.description || '',
        display_url: item.breadcrumb || '',
        url: item.url || '',
        sitelinks: (item.sitelinks || []).map(s => ({ title: s.title })),
        callouts: [],
        source: 'google'
      }));
    }

    res.json({ success: true, data: { keyword: query, ads, total: ads.length } });
  } catch(err) {
    console.error('[ads-analyzer]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/ads-transparency ────────────────────────────────────────────────
app.post('/api/ads-transparency', async (req, res) => {
  try {
    const { domain, keyword, advertiser, search_type = 'domain', location_code = 2840, location_codes,
            language_code = 'en', date_from, date_to, depth = 40, sort_by = 'newest', platform = '' } = req.body;

    const searchQuery = domain || keyword || advertiser || '';
    if (!searchQuery) return res.status(400).json({ error: 'Search query is required' });

    const headers = { Authorization: getAuthHeader(), 'Content-Type': 'application/json' };
    let advertiser_ids = [];
    req._advertiserList = [];

    if (search_type !== 'domain') {
      const advRes = await axios.post(
        `${DFORSEO_BASE}/serp/google/ads_advertisers/live/advanced`,
        [{ location_code, language_code, depth: 20, keyword: keyword || advertiser || searchQuery }],
        { headers }
      );
      const advTask = advRes.data?.tasks?.[0];
      if (advTask?.status_code === 20000) {
        const advItems = advTask.result?.[0]?.items || [];
        const filtered = search_type === 'advertiser'
          ? advItems.filter(i => (i.title||'').toLowerCase().includes(searchQuery.toLowerCase()))
          : advItems;
        advertiser_ids = filtered.map(i => i.advertiser_id).filter(Boolean).slice(0, 5);
        req._advertiserList = filtered.slice(0, 5).map(i => ({
          id: i.advertiser_id, name: i.title || i.advertiser_id,
          location: i.location || '', verified: i.verified || false,
          approx_ads: i.approx_ads_count || 0
        }));
        console.log('Advertisers found:', req._advertiserList.map(a=>a.name).join(', '));
      }
      if (!advertiser_ids.length) {
        return res.status(400).json({ error: `No advertiser found for "${searchQuery}".` });
      }
    } else {
      console.log('Domain search:', searchQuery);
    }

    const geoList = location_codes?.length ? location_codes : [location_code];
    const taskPayloads = geoList.map(loc => {
      const p = { location_code: loc, language_code, depth: Math.min(depth, 100) };
      if (search_type === 'domain') p.target = searchQuery;
      else p.advertiser_ids = advertiser_ids;
      if (platform) p.platform = platform;
      if (date_from) p.date_from = date_from;
      if (date_to) p.date_to = date_to;
      return p;
    });

    const taskRes = await axios.post(
      `${DFORSEO_BASE}/serp/google/ads_search/task_post`,
      taskPayloads, { headers }
    );
    const tasks = taskRes.data?.tasks || [];
    const taskIds = tasks.filter(t => t.status_code === 20100).map(t => t.id);
    if (!taskIds.length) {
      return res.status(400).json({ error: tasks[0]?.status_message || 'Failed to post tasks' });
    }

    const pollTask = async (taskId) => {
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const getRes = await axios.get(
          `${DFORSEO_BASE}/serp/google/ads_search/task_get/advanced/${taskId}`,
          { headers: { Authorization: getAuthHeader() } }
        );
        const t = getRes.data?.tasks?.[0];
        if (t?.status_code === 20000) return t;
        if (t?.status_code === 40000 || t?.status_code === 40400) return null;
      }
      return null;
    };

    const results = await Promise.all(taskIds.map(pollTask));
    const allItems = results.flatMap(r => r?.result?.[0]?.items || []);
    console.log('Real transparency ads found:', allItems.length);

    if (!allItems.length) {
      return res.status(400).json({ error: 'No results found. Please try again.' });
    }

    const ads = allItems.map((item, idx) => ({
      position: item.rank_absolute || idx + 1,
      advertiser: item.title || searchQuery,
      advertiser_id: item.advertiser_id || '',
      creative_id: item.creative_id || '',
      domain: searchQuery,
      format: item.format || 'unknown',
      preview_url: item.preview_url || null,
      preview_image: item.preview_image?.url || null,
      preview_width: item.preview_image?.width || 348,
      preview_height: item.preview_image?.height || 180,
      transparency_url: item.url || '',
      verified: item.verified || false,
      titles: item.title ? [item.title] : [],
      description: item.description || '',
      display_url: item.display_url || searchQuery,
      first_seen: item.first_shown || item.first_seen || null,
      last_seen: item.last_shown || item.last_seen || null,
      source: 'transparency'
    }));

    res.json({
      success: true,
      data: {
        domain: searchQuery, ads, total: ads.length,
        advertiser_ids,
        advertisers: req._advertiserList || [],
        source: 'google_transparency'
      }
    });
  } catch(err) {
    console.error('[ads-transparency]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/meta-ads ────────────────────────────────────────────────────────
app.post('/api/meta-ads', async (req, res) => {
  try {
    const { query, country = 'GB', status = 'active', media_type = 'all', limit = 50, mode = 'keyword' } = req.body;
    const META_TOKEN = process.env.META_ADS_TOKEN;
    if (!META_TOKEN) return res.status(503).json({ error: 'META_ADS_TOKEN not configured' });

    const params = {
      access_token: META_TOKEN,
      search_terms: query,
      ad_active_status: status === 'active' ? 'ACTIVE' : status === 'inactive' ? 'INACTIVE' : 'ALL',
      ad_reached_countries: country === 'ALL' ? undefined : `["${country}"]`,
      ad_type: 'ALL',
      limit: Math.min(limit, 200),
      fields: 'id,ad_creation_time,ad_delivery_start_time,ad_snapshot_url,page_name,page_id,body_text,title,description,ad_creative_link_titles,ad_creative_link_descriptions,ad_creative_bodies,ad_creative_link_captions,impressions,spend,demographic_distribution,delivery_by_region,publisher_platforms'
    };
    if (media_type !== 'all') params.ad_type = media_type.toUpperCase();

    const response = await axios.get('https://graph.facebook.com/v19.0/ads_archive', { params });
    const rawAds = response.data?.data || [];

    const ads = rawAds.map(ad => ({
      id: ad.id,
      page_name: ad.page_name || '',
      body: (ad.ad_creative_bodies || [ad.body_text])[0] || '',
      title: (ad.ad_creative_link_titles || [ad.title])[0] || '',
      description: (ad.ad_creative_link_descriptions || [ad.description])[0] || '',
      image_url: ad.ad_snapshot_url || '',
      start_date: ad.ad_delivery_start_time?.split('T')[0] || '',
      created_time: ad.ad_creation_time?.split('T')[0] || '',
      platforms: ad.publisher_platforms || [],
      status: 'ACTIVE',
      media_type: ad.ad_type || 'all',
    }));

    res.json({ success: true, data: { query, ads, total: ads.length } });
  } catch(err) {
    console.error('[meta-ads]', err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ── POST /api/oxylabs-ppc ─────────────────────────────────────────────────────
app.post('/api/oxylabs-ppc', async (req, res) => {
  try {
    const { keyword, location_code = 2826, depth = 1 } = req.body;
    if (!keyword) return res.status(400).json({ error: 'keyword is required' });

    const geo = {2826:'gb',2840:'us',2124:'ca',2036:'au',2276:'de',2616:'pl'}[location_code] || 'gb';

    const payload = {
      source: 'google_ads',
      query: keyword,
      geo_location: geo,
      parse: true,
      pages: Math.min(depth, 5),
      locale: 'en-gb',
    };

    const response = await axios.post(
      'https://realtime.oxylabs.io/v1/queries',
      payload,
      { auth: { username: OXYLABS_USER, password: OXYLABS_PASS }, timeout: 60000 }
    );

    const results = response.data?.results || [];
    const ads = [];
    const organic = [];

    results.forEach(r => {
      const content = r.content || {};
      (content.paid || []).forEach((item, idx) => {
        ads.push({
          position: idx + 1,
          title: item.title || '',
          url: item.url || '',
          description: item.desc || item.description || '',
          display_url: item.url_shown || '',
          domain: item.url ? (() => { try { return new URL(item.url).hostname.replace('www.',''); } catch(e) { return ''; } })() : '',
          sitelinks: (item.sitelinks || []).map(s => ({ title: s.title, url: s.url })),
        });
      });
      (content.results || []).forEach((item, idx) => {
        organic.push({
          position: idx + 1,
          title: item.title || '',
          url: item.url || '',
          description: item.desc || '',
          domain: item.url ? (() => { try { return new URL(item.url).hostname.replace('www.',''); } catch(e) { return ''; } })() : '',
        });
      });
    });

    res.json({ success: true, data: { keyword, ads, organic, total: ads.length } });
  } catch(err) {
    console.error('[oxylabs-ppc]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/site-audit ──────────────────────────────────────────────────────
app.post('/api/site-audit', async (req, res) => {
  try {
    const { domain: target, location_code: locationCode = 2840, language_code = 'en' } = req.body;
    if (!target) return res.status(400).json({ error: 'domain is required' });

    const headers = { Authorization: getAuthHeader(), 'Content-Type': 'application/json' };

    // Probe 15 GEOs to find effective location
    const PROBE_GEOS = [2840,2826,2124,2036,2276,2616,2356,2076,2724,2380,2250,2528,2804,2566,2710];
    const probeResults = await Promise.all(
      PROBE_GEOS.map(loc =>
        axios.post(`${DFORSEO_BASE}/dataforseo_labs/google/domain_rank_overview/live`,
          [{ target, location_code: loc, language_code }], { headers })
          .then(r => ({ loc, data: r.data?.tasks?.[0]?.result?.[0]?.items?.[0] }))
          .catch(() => ({ loc, data: null }))
      )
    );

    const probeMap = {};
    probeResults.forEach(({ loc, data }) => {
      if (data) probeMap[loc] = data;
    });

    // Find top GEO
    let effectiveLocation = locationCode;
    let maxEtv = 0;
    Object.entries(probeMap).forEach(([loc, data]) => {
      const etv = data?.metrics?.organic?.etv || 0;
      if (etv > maxEtv) { maxEtv = etv; effectiveLocation = parseInt(loc); }
    });

    console.log(`Site audit for: ${target} [GLOBAL -> ${effectiveLocation}]`);

    // Parallel requests
    const safe = fn => fn().catch(e => { console.error(e.message); return null; });
    const [kwRes, blRes, compRes, pagesRes, histRes] = await Promise.all([
      // Keywords
      safe(() => axios.post(`${DFORSEO_BASE}/dataforseo_labs/google/ranked_keywords/live`,
        [{ target, location_code: effectiveLocation, language_code, limit: 20, order_by: ['ranked_serp_element.serp_item.etv,desc'] }], { headers })),
      // Backlinks
      safe(() => axios.post(`${DFORSEO_BASE}/backlinks/summary/live`,
        [{ target, limit: 1, include_subdomains: true }], { headers })),
      // Competitors
      safe(() => axios.post(`${DFORSEO_BASE}/dataforseo_labs/google/competitors_domain/live`,
        [{ target, location_code: effectiveLocation, language_code, limit: 20 }], { headers })),
      // Pages
      safe(() => Promise.resolve(null)),
      // Historical rank
      safe(() => axios.post(`${DFORSEO_BASE}/dataforseo_labs/google/historical_rank_overview/live`,
        [{ target, location_code: effectiveLocation, language_code }], { headers })),
    ]);

    // Backlinks
    const blItem = blRes?.data?.tasks?.[0]?.result?.[0] || {};
    const backlinks = {
      total: blItem.total_count || blItem.backlinks || 0,
      referring_domains: blItem.referring_domains || blItem.referring_main_domains || 0,
      dofollow: blItem.referring_main_domains_dofollow || blItem.dofollow || 0,
      rank: blItem.rank || blItem.domain_rank || probeMap[effectiveLocation]?.domain_rank || 0,
    };
    // Use probe data for rank if backlinks empty
    if (!backlinks.rank && overviewData) {
      backlinks.rank = overviewData.domain_rank || 0;
    }

    // Overview
    const overviewData = probeMap[effectiveLocation];
    const organic = overviewData?.metrics?.organic || {};
    const paid = overviewData?.metrics?.paid || {};
    const overview = {
      organic_keywords: organic.count || 0,
      organic_traffic: Math.round(organic.etv || 0),
      organic_traffic_value: Math.round(organic.estimated_paid_traffic_cost || organic.etv_cost || 0),
      paid_keywords: paid.count || 0,
      paid_traffic: Math.round(paid.etv || 0),
    };

    // Aggregate global traffic from top-5 GEOs
    const topGeos = Object.entries(probeMap)
      .map(([loc, d]) => ({ loc: parseInt(loc), etv: d?.metrics?.organic?.etv || 0 }))
      .sort((a, b) => b.etv - a.etv).slice(0, 5);

    const _globalTraffic = topGeos.reduce((s, g) => s + g.etv, 0);
    const _globalKeywords = overviewData?.metrics?.organic?.count || 0;
    const _globalTrafficValue = overviewData?.metrics?.organic?.estimated_paid_traffic_cost || overviewData?.metrics?.organic?.etv_cost || 0;
    console.log(`Global: kw: ${_globalKeywords} traffic: ${Math.round(_globalTraffic)} value: ${Math.round(_globalTrafficValue)}`);

    // GEO breakdown
    const geo = topGeos.map(g => {
      const d = probeMap[g.loc];
      const COUNTRY_MAP = {2840:'US',2826:'GB',2124:'CA',2036:'AU',2276:'DE',2616:'PL',2356:'IN',2076:'BR',2724:'ES',2380:'IT',2250:'FR',2528:'NL',2804:'UA',2566:'NG',2710:'ZA'};
      return {
        location_code: g.loc,
        country: COUNTRY_MAP[g.loc] || String(g.loc),
        traffic: Math.round(g.etv),
        keywords: d?.metrics?.organic?.count || 0,
        traffic_share: _globalTraffic > 0 ? Math.round(g.etv / _globalTraffic * 100) : 0,
      };
    });
    console.log('Overview:', overviewData ? '20000' : 'null');

    // Keywords
    const kwItems = kwRes?.data?.tasks?.[0]?.result?.[0]?.items || [];
    const domainName = target.split('.')[0].toLowerCase();
    const localTermsKw = ['near me','nearby','local','in my area','city','town','london','toronto','new york'];

    const keywords = kwItems.slice(0, 20).map(item => {
      const kw = (item.keyword_data?.keyword || '').toLowerCase();
      const traffic = item.ranked_serp_element?.serp_item?.etv || 0;
      const pos = item.ranked_serp_element?.serp_item?.rank_absolute || 0;
      const isBranded = kw.includes(domainName);
      const isLocal = localTermsKw.some(t => kw.includes(t));
      return {
        keyword: item.keyword_data?.keyword || '',
        position: pos,
        volume: item.keyword_data?.keyword_info?.search_volume || 0,
        cpc: item.keyword_data?.keyword_info?.cpc || 0,
        traffic,
        url: item.ranked_serp_element?.serp_item?.url || '',
        intent: item.keyword_data?.search_intent_info?.main_intent || 'informational',
        branded: isBranded,
        local: isLocal,
      };
    });

    // Intent breakdown
    const intentMap = {};
    const localTerms = localTermsKw;
    kwItems.forEach(item => {
      const intent = item.keyword_data?.search_intent_info?.main_intent || 'informational';
      const traffic = item.ranked_serp_element?.serp_item?.etv || 0;
      const kw = (item.keyword_data?.keyword || '').toLowerCase();
      if (!intentMap[intent]) intentMap[intent] = { keywords: 0, traffic: 0 };
      intentMap[intent].keywords++;
      intentMap[intent].traffic += traffic;
      const brandKey = kw.includes(domainName) ? 'branded' : 'non-branded';
      if (!intentMap[brandKey]) intentMap[brandKey] = { keywords: 0, traffic: 0 };
      intentMap[brandKey].keywords++;
      intentMap[brandKey].traffic += traffic;
      const localKey = localTerms.some(t => kw.includes(t)) ? 'local' : 'non-local';
      if (!intentMap[localKey]) intentMap[localKey] = { keywords: 0, traffic: 0 };
      intentMap[localKey].keywords++;
      intentMap[localKey].traffic += traffic;
    });
    const total = kwItems.length || 1;
    const intentData = Object.entries(intentMap)
      .map(([intent, data]) => ({
        intent, keywords: data.keywords, traffic: Math.round(data.traffic),
        pct: Math.round(data.keywords / total * 100)
      }))
      .sort((a, b) => b.keywords - a.keywords);

    // Historical traffic
    const histItems = histRes?.data?.tasks?.[0]?.result?.[0]?.items || [];
    console.log(`Historical items: ${histItems.length} status:`, histRes?.data?.tasks?.[0]?.status_code);
    const trafficHistory = histItems
      .sort((a, b) => (b.year*12+b.month) - (a.year*12+a.month))
      .slice(0, 6)
      .map(item => ({
        year: item.year, month: item.month,
        traffic: Math.round(item.metrics?.organic?.etv || 0),
        keywords: item.metrics?.organic?.count || 0,
        pos_1: item.metrics?.organic?.pos_1 || 0
      }));

    // Competitors
    const compItems = compRes?.data?.tasks?.[0]?.result?.[0]?.items || [];
    const GENERIC = new Set(['youtube.com','google.com','facebook.com','instagram.com','tiktok.com','twitter.com','x.com','wikipedia.org','reddit.com','apple.com','amazon.com','microsoft.com','linkedin.com','pinterest.com']);
    const allComps = compItems
      .filter(item => item.domain && item.domain !== target)
      .sort((a, b) => (b.intersections || 0) - (a.intersections || 0));
    const niche = allComps.filter(c => !GENERIC.has(c.domain));
    const NICHE_COMPETITORS = {
      'bet365.com':['stake.com','draftkings.com','fanduel.com','williamhill.com','betway.com'],
      'stake.com':['bet365.com','draftkings.com','fanduel.com','williamhill.com','betway.com'],
    };
    let filteredComps;
    if (niche.length >= 3) filteredComps = niche.slice(0, 5);
    else if (NICHE_COMPETITORS[target]) filteredComps = NICHE_COMPETITORS[target].map(d => ({ domain: d, intersections: 0 }));
    else filteredComps = allComps.slice(0, 5);

    // Fetch competitor traffic
    const competitors = await Promise.all(
      filteredComps.map(async comp => {
        try {
          const r = await axios.post(`${DFORSEO_BASE}/dataforseo_labs/google/domain_rank_overview/live`,
            [{ target: comp.domain, location_code: effectiveLocation, language_code }], { headers });
          const d = r.data?.tasks?.[0]?.result?.[0]?.items?.[0];
          return {
            domain: comp.domain,
            common_keywords: comp.intersections || 0,
            organic_traffic: Math.round(d?.metrics?.organic?.etv || 0),
          };
        } catch(e) {
          return { domain: comp.domain, common_keywords: comp.intersections || 0, organic_traffic: 0 };
        }
      })
    );
    console.log('Competitors final:', competitors.map(c=>c.domain+':'+c.common_keywords).join(', '));

    // Referrers
    const refRes = await safe(() => axios.post(`${DFORSEO_BASE}/backlinks/referring_domains/live`,
      [{ target, limit: 100, order_by: ['rank,desc'] }], { headers }));
    const refTask = refRes?.data?.tasks?.[0];
    console.log('Referrers status:', refTask?.status_code);
    let refItems = refTask?.result?.[0]?.items || [];

    // Fallback to anchors endpoint if referring_domains fails
    if (!refItems.length) {
      const refRes2 = await safe(() => axios.post(`${DFORSEO_BASE}/backlinks/anchors/live`,
        [{ target, limit: 100, mode: 'as_is', filters: [['dofollow','=',true]] }], { headers }));
      const refTask2 = refRes2?.data?.tasks?.[0];
      console.log('Anchors fallback status:', refTask2?.status_code);
      refItems = (refTask2?.result?.[0]?.items || []).map(i => ({
        domain: i.url_from_domain || '',
        rank: i.page_rank || 0,
        backlinks: 1,
        dofollow: i.dofollow || false,
        first_seen: i.first_seen || '',
      }));
    }

    console.log('Referrers found:', refItems.length);
    const referrers = refItems.map(item => ({
      domain: item.domain || item.url_from_domain || '',
      rank: item.rank || 0,
      backlinks: item.backlinks || 1,
      dofollow: item.dofollow || false,
      first_seen: item.first_seen || '',
    }));

    const FINAL_ORGANIC = overview.organic_traffic || Math.round(_globalTraffic);
    const FINAL_KWS = overview.organic_keywords || _globalKeywords;
    console.log(`FINAL organic_traffic: ${FINAL_ORGANIC} keywords: ${FINAL_KWS}`);

    res.json({
      success: true,
      data: {
        domain: target,
        location_code: effectiveLocation,
        overview: {
          ...overview,
          organic_traffic: FINAL_ORGANIC,
          organic_keywords: FINAL_KWS,
        },
        backlinks,
        keywords,
        intent_breakdown: intentData,
        traffic_history: trafficHistory,
        competitors,
        pages: [],
        referrers,
        geo,
      }
    });
  } catch(err) {
    console.error('[site-audit]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/scrape/google ───────────────────────────────────────────────────
app.post('/api/scrape/google', async (req, res) => {
  if (!SCRAPER_URL) return res.status(503).json({ error: 'SCRAPER_URL not configured' });
  try {
    const response = await axios.post(`${SCRAPER_URL}/api/scrape/google`, req.body, { timeout: 120000 });
    res.json(response.data);
  } catch(e) {
    console.error('[scrape/google]', e.message);
    res.status(500).json({ error: e.response?.data?.error || e.message });
  }
});

// ── POST /api/screenshot ──────────────────────────────────────────────────────
app.post('/api/screenshot', async (req, res) => {
  const { url, location_code = 2826 } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const GEO_MAP = {2826:'gb',2840:'us',2124:'ca',2036:'au',2276:'de',2616:'pl',2356:'in',2076:'br'};
  const country = GEO_MAP[location_code] || 'gb';

  try {
    if (SCRAPERAPI_KEY) {
      // ScraperAPI screenshot: use screenshot=true param, get URL from sa-screenshot header
      const response = await axios.get('https://api.scraperapi.com', {
        params: { api_key: SCRAPERAPI_KEY, url, country_code: country, screenshot: 'true', render: 'true' },
        timeout: 70000,
      });
      // Screenshot URL is in the response header
      const screenshotUrl = response.headers?.['sa-screenshot'] || response.headers?.['x-screenshot'];
      console.log('Screenshot response headers:', JSON.stringify(Object.keys(response.headers || {})));
      console.log('sa-screenshot header:', screenshotUrl);
      if (screenshotUrl) {
        const imgRes = await axios.get(screenshotUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const base64 = Buffer.from(imgRes.data).toString('base64');
        return res.json({ success: true, data: { screenshot: base64, url } });
      }
      return res.json({ success: false, error: 'Screenshot URL not in headers' });
    }
    if (SCRAPER_URL) {
      const response = await axios.post(`${SCRAPER_URL}/api/screenshot`, req.body, { timeout: 60000 });
      return res.json(response.data);
    }
    res.status(503).json({ error: 'No screenshot service configured' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/crypto/create-invoice ──────────────────────────────────────────
app.post('/api/crypto/create-invoice', async (req, res) => {
  try {
    const { plan, email, coin } = req.body;
    const prices = { pro: 149, agency: 399 };
    const amount = prices[plan];
    if (!amount) return res.status(400).json({ error: 'Invalid plan' });

    const response = await axios.post(
      'https://api.nowpayments.io/v1/payment',
      { price_amount: amount, price_currency: 'usd', pay_currency: coin || 'btc', order_id: `${plan}-${Date.now()}`, order_description: `KeySpy ${plan} plan` },
      { headers: { 'x-api-key': NOWPAYMENTS_KEY, 'Content-Type': 'application/json' } }
    );
    res.json({ success: true, data: response.data });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'KeySpy Proxy' }));
app.get('/', (req, res) => res.json({ status: 'ok', service: 'KeySpy Proxy' }));

app.listen(PORT, () => console.log(`KeySpy proxy running on port ${PORT}`));
