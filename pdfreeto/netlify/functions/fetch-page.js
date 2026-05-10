const https = require('https');
const http = require('http');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const url = event.queryStringParameters?.url;
  if (!url) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing url parameter' }) };
  }

  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PDFreeto SEO Bot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    };

    const req = client.get(url, options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve({
          statusCode: 200,
          headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' },
          body: ''
        });
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: 200,
          headers: {
            'Content-Type': 'text/html',
            'Access-Control-Allow-Origin': '*'
          },
          body: data.substring(0, 500000) // limit to 500KB
        });
      });
    });

    req.on('error', (err) => {
      resolve({
        statusCode: 500,
        body: JSON.stringify({ error: err.message })
      });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ statusCode: 408, body: JSON.stringify({ error: 'Timeout' }) });
    });
  });
};
