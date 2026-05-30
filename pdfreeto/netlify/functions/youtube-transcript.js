const https = require('https');
const http = require('http');

function get(url, headers) {
  return new Promise((resolve, reject) => {
    var client = url.startsWith('https') ? https : http;
    var req = client.get(url, {
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }, headers || {})
    }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location, headers).then(resolve).catch(reject);
      }
      var data = '';
      res.setEncoding('utf8');
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve({ status: res.statusCode, body: data }); });
    });
    req.on('error', reject);
    req.setTimeout(20000, function() { req.destroy(new Error('Timeout')); });
  });
}

function extractVideoId(url) {
  var patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
    /\/watch\/([A-Za-z0-9_-]{11})/,
  ];
  for (var p of patterns) {
    var m = url.match(p);
    if (m) return m[1];
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

function decodeHTML(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n)); });
}

function extractCaptionTracks(body) {
  // Strategy 1: find captionTracks array directly
  var patterns = [
    /"captionTracks"\s*:\s*(\[.*?\])\s*,\s*"audioTracks"/s,
    /"captionTracks"\s*:\s*(\[.*?\])\s*,\s*"defaultAudioTrack"/s,
    /"captionTracks"\s*:\s*(\[.*?\])\s*\}/s,
    /"captionTracks"\s*:\s*(\[[\s\S]+?(?:\](?=\s*,|\s*\})))/,
  ];

  for (var p of patterns) {
    try {
      var m = body.match(p);
      if (m) {
        var parsed = JSON.parse(m[1]);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch(e) {}
  }

  // Strategy 2: extract individual baseUrl values
  var tracks = [];
  var re = /"baseUrl"\s*:\s*"(https:\/\/www\.youtube\.com\/api\/timedtext[^"]+)"/g;
  var match;
  while ((match = re.exec(body)) !== null) {
    var url = match[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    // Extract lang from URL
    var langMatch = url.match(/[?&]lang=([^&]+)/);
    tracks.push({ baseUrl: url, languageCode: langMatch ? langMatch[1] : 'unknown' });
  }
  if (tracks.length > 0) return tracks;

  return null;
}

async function fetchTranscriptFromUrl(captionUrl) {
  // Try JSON3 format first
  var jsonUrl = captionUrl + (captionUrl.includes('?') ? '&' : '?') + 'fmt=json3';
  var res = await get(jsonUrl);

  if (res.status === 200) {
    try {
      var data = JSON.parse(res.body);
      var texts = [];
      if (data.events) {
        for (var ev of data.events) {
          if (ev.segs) {
            var seg = ev.segs.map(function(s) { return s.utf8 || ''; }).join('').trim();
            if (seg && seg !== '\n') texts.push(seg);
          }
        }
      }
      if (texts.length > 0) {
        return texts.join(' ').replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
      }
    } catch(e) {}
  }

  // Fallback: XML format
  var xmlRes = await get(captionUrl);
  if (xmlRes.status === 200) {
    var xmlTexts = [];
    var xmlRe = /<text[^>]*>([\s\S]*?)<\/text>/g;
    var xmlMatch;
    while ((xmlMatch = xmlRe.exec(xmlRes.body)) !== null) {
      var t = decodeHTML(xmlMatch[1]).trim();
      if (t) xmlTexts.push(t);
    }
    if (xmlTexts.length > 0) {
      return xmlTexts.join(' ').replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
    }
  }

  throw new Error('Could not parse captions');
}

async function fetchTranscript(videoId) {
  // Fetch YouTube page
  var page = await get('https://www.youtube.com/watch?v=' + videoId);
  if (page.status !== 200) throw new Error('YouTube returned status ' + page.status);

  var body = page.body;

  // Try to extract caption tracks
  var tracks = extractCaptionTracks(body);

  if (!tracks || tracks.length === 0) {
    // Strategy 3: try direct timedtext API
    var langs = ['en', 'pt', 'pt-PT', 'pt-BR', 'es', 'fr', 'de', 'a.en', 'a.pt'];
    for (var lang of langs) {
      try {
        var ttUrl = 'https://www.youtube.com/api/timedtext?v=' + videoId + '&lang=' + lang + '&fmt=json3';
        var ttRes = await get(ttUrl);
        if (ttRes.status === 200 && ttRes.body.length > 100) {
          var ttData = JSON.parse(ttRes.body);
          if (ttData.events && ttData.events.length > 0) {
            var texts = [];
            for (var ev of ttData.events) {
              if (ev.segs) {
                var seg = ev.segs.map(function(s) { return s.utf8 || ''; }).join('').trim();
                if (seg && seg !== '\n') texts.push(seg);
              }
            }
            if (texts.length > 0) {
              return texts.join(' ').replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
            }
          }
        }
      } catch(e) {}
    }
    throw new Error('No captions found. The video may not have subtitles, or they may be disabled by the creator.');
  }

  // Pick best track: prefer English, then Portuguese, then first
  var track = tracks.find(function(t) { return t.languageCode === 'en'; })
    || tracks.find(function(t) { return t.languageCode && t.languageCode.startsWith('en'); })
    || tracks.find(function(t) { return t.languageCode === 'pt'; })
    || tracks.find(function(t) { return t.languageCode && t.languageCode.startsWith('pt'); })
    || tracks[0];

  var baseUrl = track.baseUrl;
  // Decode unicode escapes in URL
  baseUrl = baseUrl.replace(/\\u0026/g, '&').replace(/\\\//g, '/');

  return await fetchTranscriptFromUrl(baseUrl);
}

async function getVideoTitle(videoId) {
  try {
    var r = await get('https://www.youtube.com/oembed?url=https://youtube.com/watch?v=' + videoId + '&format=json');
    if (r.status === 200) return JSON.parse(r.body).title || '';
  } catch(e) {}
  return '';
}

exports.handler = async function(event) {
  var cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  var qs = event.queryStringParameters || {};
  var url = qs.url || '';
  var debug = qs.debug === '1';

  if (!url) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing url' }) };

  var videoId = extractVideoId(url);
  if (!videoId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid YouTube URL' }) };

  try {
    if (debug) {
      // Return debug info about what's found on the page
      var page = await get('https://www.youtube.com/watch?v=' + videoId);
      var tracks = extractCaptionTracks(page.body);
      return {
        statusCode: 200,
        headers: Object.assign({ 'Content-Type': 'application/json' }, cors),
        body: JSON.stringify({
          videoId,
          pageStatus: page.status,
          pageLength: page.body.length,
          tracksFound: tracks ? tracks.length : 0,
          trackSample: tracks ? tracks.slice(0,3).map(function(t){ return {lang: t.languageCode, url: (t.baseUrl||'').substring(0,80)}; }) : [],
          hasCaptionTracks: page.body.includes('captionTracks'),
          hasTimedtext: page.body.includes('timedtext'),
        })
      };
    }

    var [transcript, title] = await Promise.all([
      fetchTranscript(videoId),
      getVideoTitle(videoId)
    ]);

    var text = transcript.substring(0, 40000);
    return {
      statusCode: 200,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors),
      body: JSON.stringify({ videoId, title, transcript: text, truncated: transcript.length > 40000, chars: text.length })
    };
  } catch(e) {
    return {
      statusCode: 200,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors),
      body: JSON.stringify({ error: e.message })
    };
  }
};
