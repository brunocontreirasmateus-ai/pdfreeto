const https = require('https');
const http = require('http');

function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve) => {
    if (redirectCount > 5) {
      return resolve({ statusCode: 200, body: '' });
    }

    const client = url.startsWith('https') ? https : http;

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
      }
    };

    const req = client.get(url, options, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        // Handle relative redirects
        if (redirectUrl.startsWith('/')) {
          const parsed = new URL(url);
          redirectUrl = parsed.origin + redirectUrl;
        }
        res.resume(); // consume response body
        return fetchUrl(redirectUrl, redirectCount + 1).then(resolve);
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data.substring(0, 500000) });
      });
    });

    req.on('error', (err) => {
      resolve({ statusCode: 500, body: '' });
    });

    req.setTimeout(12000, () => {
      req.destroy();
      resolve({ statusCode: 408, body: '' });
    });
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const url = event.queryStringParameters?.url;
  if (!url) {
    return { statusCode: 400, body: '' };
  }

  // Ensure URL has protocol
  const fullUrl = url.startsWith('http') ? url : 'https://' + url;

  const result = await fetchUrl(fullUrl);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    },
    body: result.body
  };
};

