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
      // Stream with size limit — stop at 5.5MB to stay under Netlify's 6MB base64 limit
      var chunks = [];
      var total = 0;
      var limit = 5500000;
      res.on('data', function(c) {
        total += c.length;
        if (total <= limit) chunks.push(Buffer.from(c));
      });
      res.on('end', function() {
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || 'image/jpeg',
          data: Buffer.concat(chunks),
          truncated: total > limit
        });
      });
    }).on('error', reject).setTimeout(12000, function() { this.destroy(new Error('Timeout')); });
  });
}

function isValidImage(img) {
  if (!img || img.status !== 200 || img.data.length < 500) return false;
  var ct = (img.contentType || '').toLowerCase();
  if (ct.includes('text') || ct.includes('html') || ct.includes('json')) return false;
  var b = img.data;
  return (b[0] === 0xFF && b[1] === 0xD8) || // JPEG
         (b[0] === 0x89 && b[1] === 0x50) || // PNG
         (b[8] === 0x57 && b[9] === 0x45);   // WEBP
}

exports.handler = async function(event) {
  var url = (event.queryStringParameters || {}).url || '';
  if (!url || !url.startsWith('https://imgs.vercapas.com/')) {
    return { statusCode: 400, body: 'Invalid URL' };
  }

  try {
    var img = null;

    // Fetch requested URL (full-size or thumbnail)
    try { img = await fetchImage(url); } catch(e) { img = null; }

    // If truncated (>5.5MB), convert full-size URL to thumbnail and retry
    if (img && img.truncated && !url.includes('/th/')) {
      var thumbUrl = url.replace(/\/covers\/([^/]+)\/(\d+)\//, '/covers/$1/$2/th/');
      try {
        var thumb = await fetchImage(thumbUrl);
        if (isValidImage(thumb)) img = thumb;
      } catch(e) {}
    }

    // If invalid and was full-size, try thumbnail as last resort
    if (!isValidImage(img) && !url.includes('/th/')) {
      var thumbUrl2 = url.replace(/\/covers\/([^/]+)\/(\d+)\//, '/covers/$1/$2/th/');
      try {
        var thumb2 = await fetchImage(thumbUrl2);
        if (isValidImage(thumb2)) img = thumb2;
      } catch(e) {}
    }

    if (!isValidImage(img)) {
      return { statusCode: 404, body: 'Not found' };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': img.contentType.includes('png') ? 'image/png' : 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      },
      body: img.data.toString('base64'),
      isBase64Encoded: true
    };

  } catch(e) {
    return { statusCode: 500, body: e.message };
  }
};
