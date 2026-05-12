const https = require('https');
const http = require('http');

// StreamElements TTS — free, no API key needed
// Voices: Brian (en), Joanna (en-US), Ines (pt-PT), Vitoria (pt-BR),
//         Conchita (es), Celine (fr), Marlene (de), Giorgio (it)
const VOICE_MAP = {
  'en': 'Brian',
  'en-GB': 'Brian',
  'en-US': 'Joanna',
  'pt': 'Ines',
  'pt-PT': 'Ines',
  'pt-BR': 'Vitoria',
  'es': 'Conchita',
  'fr': 'Celine',
  'de': 'Marlene',
  'it': 'Giorgio',
};

function fetchAudio(url) {
  return new Promise((resolve, reject) => {
    var client = url.startsWith('https') ? https : http;
    client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8',
      }
    }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchAudio(res.headers.location).then(resolve).catch(reject);
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(Buffer.from(c)); });
      res.on('end', function() {
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || 'audio/mpeg',
          data: Buffer.concat(chunks)
        });
      });
    }).on('error', reject).setTimeout(20000, function() { this.destroy(new Error('Timeout')); });
  });
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  }

  var body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) {}

  var text = (body.text || '').trim();
  var lang = (body.lang || 'en').toLowerCase();

  if (!text) return { statusCode: 400, body: 'Missing text' };
  if (text.length > 3000) text = text.substring(0, 3000);

  // Pick voice for language
  var voice = VOICE_MAP[lang] || VOICE_MAP[lang.split('-')[0]] || 'Brian';

  var url = 'https://api.streamelements.com/kappa/v2/speech?voice=' + encodeURIComponent(voice) + '&text=' + encodeURIComponent(text);

  try {
    var audio = await fetchAudio(url);
    if (audio.status !== 200 || audio.data.length < 1000) {
      return { statusCode: 502, body: 'TTS service unavailable' };
    }
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-Voice': voice
      },
      body: audio.data.toString('base64'),
      isBase64Encoded: true
    };
  } catch(e) {
    return { statusCode: 500, body: e.message };
  }
};
