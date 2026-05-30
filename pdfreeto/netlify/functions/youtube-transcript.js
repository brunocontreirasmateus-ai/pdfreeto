const https = require('https');
const http = require('http');

function get(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    var client = url.startsWith('https') ? https : http;
    var req = client.get(url, {
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      }, extraHeaders || {})
    }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      var data = '';
      res.setEncoding('utf8');
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve({ status: res.statusCode, body: data }); });
    });
    req.on('error', reject);
    req.setTimeout(15000, function() { req.destroy(new Error('Timeout')); });
  });
}

function post(url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    var u = new URL(url);
    var opts = {
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      }, extraHeaders || {})
    };
    var client = url.startsWith('https') ? https : http;
    var req = client.request(opts, function(res) {
      var data = '';
      res.setEncoding('utf8');
      res.on('data', function(c) { data += c; });
      res.on('end', function() { resolve({ status: res.statusCode, body: data }); });
    });
    req.on('error', reject);
    req.setTimeout(15000, function() { req.destroy(new Error('Timeout')); });
    req.write(body);
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
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(parseInt(n)));
}

function parseXmlTranscript(xml) {
  var texts = [];
  var re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  var m;
  while ((m = re.exec(xml)) !== null) {
    var t = decodeHTML(m[1].replace(/<[^>]+>/g,'')).trim();
    if (t) texts.push(t);
  }
  return texts.join(' ').replace(/\[.*?\]/g,'').replace(/\s+/g,' ').trim();
}

async function fetchTranscript(videoId) {
  var errors = [];

  // ── Strategy 1: youtubetranscript.com proxy ──
  try {
    var r1 = await get('https://youtubetranscript.com/?server_vid=' + videoId);
    if (r1.status === 200 && r1.body.includes('<text')) {
      var t1 = parseXmlTranscript(r1.body);
      if (t1.length > 100) return t1;
    }
    errors.push('youtubetranscript.com: status=' + r1.status + ' len=' + r1.body.length);
  } catch(e) { errors.push('youtubetranscript.com: ' + e.message); }

  // ── Strategy 2: Tactiq transcript API ──
  try {
    var r2 = await get('https://tactiq-apps-prod.tactiq.io/transcript?videoUrl=https://www.youtube.com/watch?v=' + videoId + '&langCode=en');
    if (r2.status === 200) {
      var d2 = JSON.parse(r2.body);
      var texts = (d2.captions || d2.transcript || []).map(c => c.text || c).filter(Boolean);
      if (texts.length > 10) return texts.join(' ').replace(/\[.*?\]/g,'').replace(/\s+/g,' ').trim();
    }
    errors.push('tactiq: status=' + r2.status);
  } catch(e) { errors.push('tactiq: ' + e.message); }

  // ── Strategy 3: Downsub transcript ──
  try {
    var r3 = await get('https://downsub.com/?url=https://www.youtube.com/watch?v=' + videoId);
    if (r3.status === 200 && r3.body.includes('transcript')) {
      errors.push('downsub: got page but no direct XML');
    }
  } catch(e) { errors.push('downsub: ' + e.message); }

  // ── Strategy 4: InnerTube with browser-like cookies ──
  try {
    var innerBody = JSON.stringify({
      videoId: videoId,
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20240101.00.00',
          hl: 'en', gl: 'US',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36,gzip(gfe)',
        }
      }
    });
    var r4 = await post(
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      innerBody,
      {
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': '2.20240101.00.00',
        'Origin': 'https://www.youtube.com',
        'Referer': 'https://www.youtube.com/watch?v=' + videoId,
        'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+748; VISITOR_INFO1_LIVE=Gtm5d4IYIZE',
      }
    );
    if (r4.status === 200) {
      var d4 = JSON.parse(r4.body);
      var tracks = d4?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length > 0) {
        var track = tracks.find(t=>t.languageCode==='en')
          || tracks.find(t=>t.languageCode?.startsWith('en'))
          || tracks.find(t=>t.languageCode?.startsWith('pt'))
          || tracks[0];
        var capUrl = (track.baseUrl||'').replace(/\\u0026/g,'&');
        if (capUrl) {
          var cr = await get(capUrl + '&fmt=json3');
          if (cr.status === 200) {
            var cd = JSON.parse(cr.body);
            var segs = [];
            if (cd.events) {
              for (var ev of cd.events) {
                if (ev.segs) {
                  var s = ev.segs.map(x=>x.utf8||'').join('').trim();
                  if (s && s !== '\n') segs.push(s);
                }
              }
            }
            if (segs.length > 10) return segs.join(' ').replace(/\[.*?\]/g,'').replace(/\s+/g,' ').trim();
          }
        }
      }
    }
    errors.push('innertube: status=' + r4.status + ' tracks=' + (JSON.parse(r4.body)?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length || 0));
  } catch(e) { errors.push('innertube: ' + e.message); }

  // ── Strategy 5: allorigins proxy of timedtext ──
  try {
    var langs = ['en', 'a.en', 'pt', 'a.pt'];
    for (var lang of langs) {
      var ttUrl = 'https://www.youtube.com/api/timedtext?v=' + videoId + '&lang=' + lang + '&fmt=json3';
      var proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(ttUrl);
      var r5 = await get(proxyUrl);
      if (r5.status === 200 && r5.body.length > 200) {
        try {
          var d5 = JSON.parse(r5.body);
          if (d5.events && d5.events.length > 5) {
            var t5 = [];
            for (var ev5 of d5.events) {
              if (ev5.segs) {
                var s5 = ev5.segs.map(x=>x.utf8||'').join('').trim();
                if (s5 && s5!=='\n') t5.push(s5);
              }
            }
            if (t5.length > 10) return t5.join(' ').replace(/\[.*?\]/g,'').replace(/\s+/g,' ').trim();
          }
        } catch(e) {}
      }
    }
    errors.push('allorigins timedtext: no result');
  } catch(e) { errors.push('allorigins: ' + e.message); }

  throw new Error('All transcript methods failed: ' + errors.join(' | '));
}

async function getVideoTitle(videoId) {
  try {
    var r = await get('https://www.youtube.com/oembed?url=https://youtube.com/watch?v='+videoId+'&format=json');
    if (r.status === 200) return JSON.parse(r.body).title || '';
  } catch(e) {}
  return '';
}

exports.handler = async function(event) {
  var cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type'};
  if (event.httpMethod === 'OPTIONS') return {statusCode:200,headers:cors,body:''};

  var url = (event.queryStringParameters||{}).url||'';
  if (!url) return {statusCode:400,headers:cors,body:JSON.stringify({error:'Missing url'})};

  var videoId = extractVideoId(url);
  if (!videoId) return {statusCode:400,headers:cors,body:JSON.stringify({error:'Invalid YouTube URL'})};

  try {
    var [transcript, title] = await Promise.all([fetchTranscript(videoId), getVideoTitle(videoId)]);
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
