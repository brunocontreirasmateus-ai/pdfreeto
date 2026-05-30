exports.handler = async function(event) {
  var cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  var url = (event.queryStringParameters || {}).url || '';
  if (!url) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing url parameter' }) };

  // Extract video ID from various YouTube URL formats
  var videoId = null;
  var patterns = [
    /(?:v=|\/embed\/|\/shorts\/|youtu\.be\/)([A-Za-z0-9_-]{11})/,
    /^([A-Za-z0-9_-]{11})$/
  ];
  for (var p of patterns) {
    var m = url.match(p);
    if (m) { videoId = m[1]; break; }
  }
  if (!videoId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid YouTube URL' }) };

  try {
    var { YoutubeTranscript } = require('youtube-transcript');
    var transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'pt' })
      .catch(() => YoutubeTranscript.fetchTranscript(videoId));

    if (!transcript || transcript.length === 0) {
      return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'No transcript found. The video may not have captions.' }) };
    }

    // Combine transcript segments into plain text
    var text = transcript.map(function(t) { return t.text; }).join(' ')
      .replace(/\[.*?\]/g, '') // remove [Music], [Applause] etc
      .replace(/\s+/g, ' ').trim();

    // Limit to ~40000 chars to stay within Claude context
    var truncated = text.length > 40000;
    text = text.substring(0, 40000);

    // Get video title via oEmbed (no API key needed)
    var title = '';
    try {
      var https = require('https');
      title = await new Promise(function(resolve) {
        https.get('https://www.youtube.com/oembed?url=' + encodeURIComponent('https://youtube.com/watch?v=' + videoId) + '&format=json', function(res) {
          var d = '';
          res.on('data', function(c) { d += c; });
          res.on('end', function() {
            try { resolve(JSON.parse(d).title || ''); } catch(e) { resolve(''); }
          });
        }).on('error', function() { resolve(''); });
      });
    } catch(e) {}

    return {
      statusCode: 200,
      headers: Object.assign({ 'Content-Type': 'application/json' }, cors),
      body: JSON.stringify({ videoId, title, transcript: text, truncated, chars: text.length })
    };

  } catch(e) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: 'Failed to fetch transcript: ' + e.message })
    };
  }
};
