const https = require('https');
const http = require('http');

function fetchImage(url, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    var client = url.startsWith('https') ? https : http;
    client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.vercapas.com/',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      }
    }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        var loc = res.headers.location;
        if (loc.startsWith('/')) {
          var u = new URL(url);
          loc = u.protocol + '//' + u.host + loc;
        }
        res.resume();
        return fetchImage(loc, redirects + 1).then(resolve).catch(reject);
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(Buffer.from(c)); });
      res.on('end', function() {
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || 'image/jpeg',
          data: Buffer.concat(chunks)
        });
      });
    }).on('error', reject).setTimeout(10000, function() { this.destroy(new Error('Timeout')); });
  });
}

exports.handler = async function(event) {
  var url = (event.queryStringParameters || {}).url || '';

  // Only allow imgs.vercapas.com URLs for security
  if (!url || !url.startsWith('https://imgs.vercapas.com/')) {
    return { statusCode: 400, body: 'Invalid URL' };
  }

  try {
    var img = await fetchImage(url);
    if (img.status !== 200 || img.data.length < 100) {
      // Try thumbnail fallback if full-size failed
      if (!url.includes('/th/')) {
        var thumbUrl = url.replace(/\/covers\/([^/]+)\/(\d+)\//, '/covers/$1/$2/th/');
        try {
          img = await fetchImage(thumbUrl);
        } catch(e2) {}
      }
      if (!img || img.data.length < 100) {
        return { statusCode: 404, body: 'Image not found' };
      }
    }
    // Netlify base64 limit ~4.5MB — if larger, try thumbnail instead
    if (img.data.length > 4000000 && !url.includes('/th/')) {
      var thumbUrl2 = url.replace(/\/covers\/([^/]+)\/(\d+)\//, '/covers/$1/$2/th/');
      try {
        var thumbImg = await fetchImage(thumbUrl2);
        if (thumbImg.data.length > 100) img = thumbImg;
      } catch(e3) {}
    }
    return {
      statusCode: 200,
      headers: {
        'Content-Type': img.contentType,
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff'
      },
      body: img.data.toString('base64'),
      isBase64Encoded: true
    };
  } catch(e) {
    return { statusCode: 500, body: e.message };
  }
};
