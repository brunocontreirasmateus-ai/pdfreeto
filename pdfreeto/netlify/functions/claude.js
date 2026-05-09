const https = require('https');

exports.handler = async function (event) {
  console.log('Function called, method:', event.httpMethod);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  console.log('API key present:', !!apiKey);
  console.log('API key starts with:', apiKey ? apiKey.substring(0, 10) : 'MISSING');

  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
    body.stream = false;
    console.log('Request model:', body.model);
    console.log('Message length:', body.messages?.[0]?.content?.length);
  } catch (e) {
    console.log('Body parse error:', e.message);
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const postData = JSON.stringify(body);

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    };

    const req = https.request(options, (res) => {
      console.log('Anthropic status:', res.statusCode);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Anthropic response:', data.substring(0, 200));
        resolve({
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: data
        });
      });
    });

    req.on('error', (err) => {
      console.log('Request error:', err.message);
      resolve({
        statusCode: 500,
        body: JSON.stringify({ error: err.message })
      });
    });

    req.write(postData);
    req.end();
  });
};
