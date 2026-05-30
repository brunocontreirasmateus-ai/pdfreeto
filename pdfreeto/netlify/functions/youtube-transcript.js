const https = require('https');
const http = require('http');

function get(url, headers) {
  return new Promise((resolve, reject) => {
    var client = url.startsWith('https') ? https : http;
    var opts = {
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }, headers || {})
    };
    var req = client.get(url, opts, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location, headers).then(resolve).catch(reject);
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

function extractVideoId(url) {
  var patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
  ];
  for (var p of patterns) {
    var m = url.match(p);
    if (m) return m[1];
  }
  // Raw video ID
  if (/^[A-Za-z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

function decodeHTML(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n)); });
}

async function fetchTranscript(videoId) {
  // Step 1: fetch video page to get captions URL
  var page = await get('https://www.youtube.com/watch?v=' + videoId);
  if (page.status !== 200) throw new Error('Video page returned ' + page.status);

  // Try to find ytInitialPlayerResponse
  var match = page.body.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);
  if (!match) {
    // Try alternate pattern
    match = page.body.match(/"captions"\s*:\s*(\{.+?"captionTracks":.+?\})\s*,\s*"videoDetails"/s);
    if (!match) throw new Error('Could not find caption data in video page');
  }

  var playerData;
  try { playerData = JSON.parse(match[1]); } catch(e) { throw new Error('Could not parse player data'); }

  // Navigate to caption tracks
  var captions = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    || playerData?.captionTracks;

  if (!captions || captions.length === 0) {
    throw new Error('No captions available for this video. Make sure the video has subtitles enabled.');
  }

  // Prefer English, then first available
  var track = captions.find(function(t) { return t.languageCode === 'en'; })
    || captions.find(function(t) { return t.languageCode && t.languageCode.startsWith('en'); })
    || captions.find(function(t) { return t.languageCode === 'pt'; })
    || captions[0];

  var captionUrl = track.baseUrl;
  if (!captionUrl) throw new Error('No caption URL found');

  // Add format=json3 for JSON output
  captionUrl += (captionUrl.includes('?') ? '&' : '?') + 'fmt=json3';

  // Step 2: fetch captions
  var capRes = await get(captionUrl);
  if (capRes.status !== 200) throw new Error('Caption fetch failed: ' + capRes.status);

  // Parse JSON3 format
  var capData;
  try { capData = JSON.parse(capRes.body); } catch(e) {
    // Fallback: try XML parsing
    var xmlText = capRes.body;
    var texts = [];
    var xmlMatch;
    var xmlRe = /<text[^>]*>([^<]*)<\/text>/g;
    while ((xmlMatch = xmlRe.exec(xmlText)) !== null) {
      texts.push(decodeHTML(xmlMatch[1].trim()));
    }
    if (texts.length === 0) throw new Error('Could not parse captions');
    return texts.join(' ').replace(/\s+/g, ' ').trim();
  }

  // Extract text from json3 events
  var texts = [];
  if (capData.events) {
    for (var ev of capData.events) {
      if (ev.segs) {
        var seg = ev.segs.map(function(s) { return s.utf8 || ''; }).join('').trim();
        if (seg && seg !== '\n') texts.push(decodeHTML(seg));
      }
    }
  }

  if (texts.length === 0) throw new Error('No caption text found');
  return texts.join(' ').replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
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

  var url = (event.queryStringParameters || {}).url || '';
  if (!url) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing url parameter' }) };

  var videoId = extractVideoId(url);
  if (!videoId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid YouTube URL — could not extract video ID' }) };

  try {
    var [transcript, title] = await Promise.all([
      fetchTranscript(videoId),
      getVideoTitle(videoId)
    ]);

    var truncated = transcript.length > 40000;
    var text = transcript.substring(0, 40000);

    return {
      statusCode: 200,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors),
      body: JSON.stringify({ videoId, title, transcript: text, truncated, chars: text.length })
    };
  } catch(e) {
    return {
      statusCode: 200,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors),
      body: JSON.stringify({ error: e.message })
    };
  }
};
