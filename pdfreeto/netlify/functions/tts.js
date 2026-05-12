const https = require('https');
const http = require('http');
const querystring = require('querystring');

function get(url, opts) {
  return new Promise((resolve, reject) => {
    var client = url.startsWith('https') ? https : http;
    var req = client.get(url, opts || {}, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location, opts).then(resolve).catch(reject);
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(Buffer.from(c)); });
      res.on('end', function() { resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', data: Buffer.concat(chunks) }); });
    });
    req.on('error', reject);
    req.setTimeout(15000, function() { req.destroy(new Error('Timeout')); });
  });
}

function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    var parsed = new URL(url);
    var opts = {
      hostname: parsed.hostname, port: parsed.port || (url.startsWith('https') ? 443 : 80),
      path: parsed.pathname + parsed.search, method: 'POST',
      headers: Object.assign({ 'Content-Length': Buffer.byteLength(body) }, headers)
    };
    var client = url.startsWith('https') ? https : http;
    var req = client.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(Buffer.from(c)); });
      res.on('end', function() { resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', data: Buffer.concat(chunks) }); });
    });
    req.on('error', reject);
    req.setTimeout(15000, function() { req.destroy(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

function isAudio(r) {
  return r && r.status === 200 && r.data.length > 1000 &&
    (r.ct.includes('audio') || r.ct.includes('mpeg') || r.ct.includes('octet') ||
     (r.data[0] === 0xFF && (r.data[1] & 0xE0) === 0xE0) || // MP3 sync
     (r.data[0] === 0x49 && r.data[1] === 0x44 && r.data[2] === 0x33)); // ID3
}

var VOICES = { 'en': 'Brian', 'pt': 'Ines', 'pt-PT': 'Ines', 'pt-BR': 'Vitoria',
               'es': 'Conchita', 'fr': 'Celine', 'de': 'Marlene', 'it': 'Giorgio' };

exports.handler = async function(event) {
  var headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  var body = {}; try { body = JSON.parse(event.body || '{}'); } catch(e) {}
  var text = (body.text || '').trim().substring(0, 1500);
  var lang = (body.lang || 'en').toLowerCase().split('-')[0];
  if (!text) return { statusCode: 400, headers, body: 'Missing text' };

  var errors = [];

  // ── Service 1: StreamElements ──
  try {
    var voice = VOICES[body.lang] || VOICES[lang] || 'Brian';
    var r = await get(
      'https://api.streamelements.com/kappa/v2/speech?voice=' + encodeURIComponent(voice) + '&text=' + encodeURIComponent(text),
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'audio/mpeg,audio/*;q=0.9' } }
    );
    if (isAudio(r)) return { statusCode: 200, headers: Object.assign({ 'Content-Type': 'audio/mpeg' }, headers), body: r.data.toString('base64'), isBase64Encoded: true };
    errors.push('StreamElements: ' + r.status);
  } catch(e) { errors.push('StreamElements: ' + e.message); }

  // ── Service 2: Google Translate TTS ──
  try {
    var gtLang = lang === 'pt' ? 'pt-PT' : lang;
    var gtUrl = 'https://translate.google.com/translate_tts?ie=UTF-8&tl=' + encodeURIComponent(gtLang) +
                '&client=gtx&q=' + encodeURIComponent(text.substring(0, 200));
    var r2 = await get(gtUrl, { headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://translate.google.com/',
      'Accept': 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8'
    }});
    if (isAudio(r2)) return { statusCode: 200, headers: Object.assign({ 'Content-Type': 'audio/mpeg' }, headers), body: r2.data.toString('base64'), isBase64Encoded: true };
    errors.push('Google TTS: ' + r2.status);
  } catch(e) { errors.push('Google TTS: ' + e.message); }

  // ── Service 3: ttsmp3.com ──
  try {
    var ttsLang = { 'pt': 'pt-pt', 'es': 'es-es', 'fr': 'fr-fr', 'de': 'de-de', 'en': 'en-gb' }[lang] || 'en-us';
    var postBody = 'msg=' + encodeURIComponent(text.substring(0, 300)) + '&lang=' + ttsLang + '&source=ttsmp3';
    var r3 = await post('https://ttsmp3.com/makemp3_new.php', postBody, {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0', 'Referer': 'https://ttsmp3.com/'
    });
    if (r3.status === 200) {
      var json = JSON.parse(r3.data.toString());
      if (json.URL) {
        var r3b = await get(json.URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (isAudio(r3b)) return { statusCode: 200, headers: Object.assign({ 'Content-Type': 'audio/mpeg' }, headers), body: r3b.data.toString('base64'), isBase64Encoded: true };
      }
    }
    errors.push('ttsmp3: ' + r3.status);
  } catch(e) { errors.push('ttsmp3: ' + e.message); }

  return { statusCode: 503, headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
           body: JSON.stringify({ error: 'All TTS services failed', details: errors }) };
};
