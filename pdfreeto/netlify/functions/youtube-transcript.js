const https = require('https');

function post(url, bodyObj, headers) {
  return new Promise((resolve, reject) => {
    var body = JSON.stringify(bodyObj);
    var u = new URL(url);
    var opts = {
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'com.google.android.youtube/17.36.4 (Linux; U; Android 12; GB) gzip',
        'X-Goog-Api-Format-Version': '2',
      }, headers || {})
    };
    var req = https.request(opts, function(res) {
      var data = ''; res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Timeout')); });
    req.write(body); req.end();
  });
}

function get(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: Object.assign({'User-Agent':'Mozilla/5.0','Accept':'*/*'}, headers||{}) }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return get(res.headers.location, headers).then(resolve).catch(reject);
      var data = ''; res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject).setTimeout(15000, function() { this.destroy(); });
  });
}

function extractVideoId(url) {
  var m;
  if ((m=/[?&]v=([A-Za-z0-9_-]{11})/.exec(url))) return m[1];
  if ((m=/youtu\.be\/([A-Za-z0-9_-]{11})/.exec(url))) return m[1];
  if ((m=/\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/.exec(url))) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

function decodeHTML(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(n));
}

function parseCaptionEvents(events) {
  return events.filter(e=>e.segs).map(e=>e.segs.map(s=>s.utf8||'').join('').trim()).filter(s=>s&&s!=='\n').join(' ').replace(/\[.*?\]/g,'').replace(/\s+/g,' ').trim();
}

async function fetchCaptionUrl(url) {
  try {
    url = url.replace(/\\u0026/g,'&');
    var r = await get(url + (url.includes('?')?'&':'?') + 'fmt=json3');
    if (r.status === 200) {
      var d = JSON.parse(r.body);
      if (d.events && d.events.length > 5) return parseCaptionEvents(d.events);
    }
  } catch(e) {}
  try {
    var r2 = await get(url);
    if (r2.status === 200 && r2.body.includes('<text')) {
      var texts = [];
      var re = /<text[^>]*>([\s\S]*?)<\/text>/g, m;
      while ((m=re.exec(r2.body))!==null) { var t=decodeHTML(m[1]).trim(); if(t) texts.push(t); }
      if (texts.length > 5) return texts.join(' ').replace(/\[.*?\]/g,'').replace(/\s+/g,' ').trim();
    }
  } catch(e) {}
  return null;
}

async function tryClient(videoId, clientName, clientVersion, extraCtx) {
  var body = {
    videoId, context: { client: Object.assign({ clientName, clientVersion, hl:'en', gl:'US' }, extraCtx||{}) }
  };
  var headers = clientName === 'ANDROID' ? {
    'User-Agent': 'com.google.android.youtube/17.36.4 (Linux; U; Android 12; GB) gzip',
    'X-Goog-Api-Format-Version': '2',
  } : clientName === 'IOS' ? {
    'User-Agent': 'com.google.ios.youtube/17.33.2 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)',
    'X-Goog-Api-Format-Version': '2',
  } : {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'X-Origin': 'https://www.youtube.com',
    'Referer': 'https://www.youtube.com/',
  };

  var r = await post('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', body, headers);
  if (r.status !== 200) return null;
  var d = JSON.parse(r.body);
  var tracks = d?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) return null;

  var track = tracks.find(t=>t.languageCode==='en')
    || tracks.find(t=>t.languageCode?.startsWith('en'))
    || tracks.find(t=>t.languageCode?.startsWith('pt'))
    || tracks[0];

  return track?.baseUrl ? await fetchCaptionUrl(track.baseUrl) : null;
}

async function fetchTranscript(videoId) {
  var errors = [];

  // Client order: ANDROID works best for bypassing bot detection
  var clients = [
    ['ANDROID', '17.36.4', {}],
    ['IOS', '17.33.2', {}],
    ['WEB', '2.20240101.00.00', {}],
    ['TVHTML5', '7.20220325', {}],
    ['MWEB', '2.20230810.01.00', {}],
  ];

  for (var [name, ver, ctx] of clients) {
    try {
      var t = await tryClient(videoId, name, ver, ctx);
      if (t && t.length > 100) return t;
      errors.push(name + ':no_tracks');
    } catch(e) { errors.push(name + ':' + e.message.substring(0,30)); }
  }

  // Last resort: youtubetranscript.com
  try {
    var r = await get('https://youtubetranscript.com/?server_vid=' + videoId);
    if (r.status === 200 && r.body.includes('<text')) {
      var texts2 = [], re2 = /<text[^>]*>([\s\S]*?)<\/text>/g, m2;
      while ((m2=re2.exec(r.body))!==null) { var tt=decodeHTML(m2[1]).trim(); if(tt) texts2.push(tt); }
      if (texts2.length > 5) return texts2.join(' ').replace(/\[.*?\]/g,'').replace(/\s+/g,' ').trim();
    }
    errors.push('yttranscript:' + r.status);
  } catch(e) { errors.push('yttranscript:' + e.message); }

  throw new Error('Could not fetch transcript (' + errors.join(', ') + ')');
}

exports.handler = async function(event) {
  var cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type'};
  if (event.httpMethod==='OPTIONS') return {statusCode:200,headers:cors,body:''};

  var url = (event.queryStringParameters||{}).url||'';
  if (!url) return {statusCode:400,headers:cors,body:JSON.stringify({error:'Missing url'})};
  var videoId = extractVideoId(url);
  if (!videoId) return {statusCode:400,headers:cors,body:JSON.stringify({error:'Invalid YouTube URL'})};

  try {
    var [transcript, title] = await Promise.all([fetchTranscript(videoId), (async()=>{
      try { var r=await get('https://www.youtube.com/oembed?url=https://youtube.com/watch?v='+videoId+'&format=json');
        return r.status===200?JSON.parse(r.body).title||'':''; } catch(e){return '';}
    })()]);
    var text = transcript.substring(0,40000);
    return {statusCode:200,headers:Object.assign({'Content-Type':'application/json'},cors),
      body:JSON.stringify({videoId,title,transcript:text,truncated:transcript.length>40000,chars:text.length})};
  } catch(e) {
    return {statusCode:200,headers:Object.assign({'Content-Type':'application/json'},cors),
      body:JSON.stringify({error:e.message})};
  }
};
