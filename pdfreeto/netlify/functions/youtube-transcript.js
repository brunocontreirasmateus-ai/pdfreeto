const https = require('https');

function request(url, opts, body) {
  return new Promise((resolve, reject) => {
    var parsed = new URL(url);
    var options = Object.assign({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: body ? 'POST' : 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
      }
    }, opts || {});

    if (body) options.headers['Content-Length'] = Buffer.byteLength(body);

    var req = https.request(options, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return request(res.headers.location, opts, body).then(resolve).catch(reject);
      }
      var data = '';
      res.setEncoding('utf8');
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve({ status: res.statusCode, body: data }); });
    });
    req.on('error', reject);
    req.setTimeout(20000, function() { req.destroy(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function extractVideoId(url) {
  var patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
  ];
  for (var p of patterns) { var m = url.match(p); if (m) return m[1]; }
  if (/^[A-Za-z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

function decodeHTML(str) {
  return str
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/&#(\d+);/g, function(_,n){ return String.fromCharCode(parseInt(n)); });
}

async function fetchTranscript(videoId) {
  // ── Strategy 1: InnerTube player API ──
  var innertubeBody = JSON.stringify({
    videoId: videoId,
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20231215.00.00',
        hl: 'en',
        gl: 'US',
      }
    }
  });

  var playerRes = await request(
    'https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    {}, innertubeBody
  );

  if (playerRes.status === 200) {
    try {
      var playerData = JSON.parse(playerRes.body);
      var tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

      if (tracks && tracks.length > 0) {
        // Pick best language track
        var track = tracks.find(t => t.languageCode === 'en')
          || tracks.find(t => t.languageCode?.startsWith('en'))
          || tracks.find(t => t.languageCode === 'pt')
          || tracks.find(t => t.languageCode?.startsWith('pt'))
          || tracks[0];

        var captionUrl = track.baseUrl;
        if (captionUrl) {
          captionUrl = captionUrl.replace(/\\u0026/g, '&');
          var transcript = await fetchCaptionUrl(captionUrl);
          if (transcript) return transcript;
        }
      }
    } catch(e) {}
  }

  // ── Strategy 2: InnerTube get_transcript API ──
  var transcriptBody = JSON.stringify({
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20231215.00.00',
        hl: 'en',
        gl: 'US',
      }
    },
    params: Buffer.from('\n\x0b' + videoId).toString('base64')
  });

  try {
    var tRes = await request(
      'https://www.youtube.com/youtubei/v1/get_transcript?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
      {}, transcriptBody
    );

    if (tRes.status === 200) {
      var tData = JSON.parse(tRes.body);
      var runs = tData?.actions?.[0]?.updateEngagementPanelAction?.content
        ?.transcriptRenderer?.content?.transcriptSearchPanelRenderer
        ?.body?.transcriptSegmentListRenderer?.initialSegments;

      if (runs && runs.length > 0) {
        var texts = runs
          .map(s => s?.transcriptSegmentRenderer?.snippet?.runs?.[0]?.text || '')
          .filter(Boolean);
        if (texts.length > 0) return texts.join(' ').replace(/\s+/g,' ').trim();
      }
    }
  } catch(e) {}

  // ── Strategy 3: Direct timedtext API with multiple languages ──
  var langs = ['en', 'a.en', 'pt', 'a.pt', 'pt-BR', 'pt-PT', 'es', 'fr', 'de', 'it'];
  for (var lang of langs) {
    try {
      var ttUrl = 'https://www.youtube.com/api/timedtext?v=' + videoId + '&lang=' + lang + '&fmt=json3';
      var ttRes = await request(ttUrl, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (ttRes.status === 200 && ttRes.body.length > 200) {
        var ttData = JSON.parse(ttRes.body);
        if (ttData.events && ttData.events.length > 5) {
          var texts = [];
          for (var ev of ttData.events) {
            if (ev.segs) {
              var seg = ev.segs.map(s => s.utf8 || '').join('').trim();
              if (seg && seg !== '\n') texts.push(seg);
            }
          }
          if (texts.length > 10) {
            return texts.join(' ').replace(/\[.*?\]/g,'').replace(/\s+/g,' ').trim();
          }
        }
      }
    } catch(e) {}
  }

  throw new Error('Could not retrieve transcript. The video may not have captions, or they are disabled.');
}

async function fetchCaptionUrl(url) {
  // Try JSON3
  try {
    var r = await request(url + (url.includes('?') ? '&' : '?') + 'fmt=json3', {method:'GET',headers:{'User-Agent':'Mozilla/5.0'}});
    if (r.status === 200) {
      var d = JSON.parse(r.body);
      var texts = [];
      if (d.events) {
        for (var ev of d.events) {
          if (ev.segs) {
            var seg = ev.segs.map(s => s.utf8||'').join('').trim();
            if (seg && seg !== '\n') texts.push(seg);
          }
        }
      }
      if (texts.length > 0) return texts.join(' ').replace(/\[.*?\]/g,'').replace(/\s+/g,' ').trim();
    }
  } catch(e) {}

  // Try XML
  try {
    var r2 = await request(url, {method:'GET',headers:{'User-Agent':'Mozilla/5.0'}});
    if (r2.status === 200) {
      var xmlTexts = [];
      var re = /<text[^>]*>([\s\S]*?)<\/text>/g;
      var m;
      while ((m = re.exec(r2.body)) !== null) {
        var t = decodeHTML(m[1]).trim();
        if (t) xmlTexts.push(t);
      }
      if (xmlTexts.length > 0) return xmlTexts.join(' ').replace(/\[.*?\]/g,'').replace(/\s+/g,' ').trim();
    }
  } catch(e) {}

  return null;
}

async function getVideoTitle(videoId) {
  try {
    var r = await request('https://www.youtube.com/oembed?url=https://youtube.com/watch?v='+videoId+'&format=json', {method:'GET',headers:{'User-Agent':'Mozilla/5.0'}});
    if (r.status === 200) return JSON.parse(r.body).title || '';
  } catch(e) {}
  return '';
}

exports.handler = async function(event) {
  var cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type'};
  if (event.httpMethod === 'OPTIONS') return {statusCode:200,headers:cors,body:''};

  var qs = event.queryStringParameters || {};
  var url = qs.url || '';
  if (!url) return {statusCode:400,headers:cors,body:JSON.stringify({error:'Missing url'})};

  var videoId = extractVideoId(url);
  if (!videoId) return {statusCode:400,headers:cors,body:JSON.stringify({error:'Invalid YouTube URL'})};

  try {
    var [transcript, title] = await Promise.all([
      fetchTranscript(videoId),
      getVideoTitle(videoId)
    ]);
    var text = transcript.substring(0, 40000);
    return {
      statusCode: 200,
      headers: Object.assign({'Content-Type':'application/json'},cors),
      body: JSON.stringify({videoId, title, transcript:text, truncated:transcript.length>40000, chars:text.length})
    };
  } catch(e) {
    return {
      statusCode: 200,
      headers: Object.assign({'Content-Type':'application/json'},cors),
      body: JSON.stringify({error: e.message})
    };
  }
};
