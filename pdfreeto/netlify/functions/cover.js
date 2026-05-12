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
        resolve({ status: res.statusCode, contentType: res.headers['content-type'] || 'image/jpeg', data: Buffer.concat(chunks) });
      });
    }).on('error', reject).setTimeout(8000, function() { this.destroy(new Error('Timeout')); });
  });
}

function isValidImage(img) {
  // Must be 200, content must be image type, and have reasonable size
  if (!img || img.status !== 200 || img.data.length < 1000) return false;
  var ct = img.contentType || '';
  if (ct.includes('text') || ct.includes('html') || ct.includes('json')) return false;
  // Check JPEG/PNG magic bytes
  var b = img.data;
  var isJpeg = b[0] === 0xFF && b[1] === 0xD8;
  var isPng  = b[0] === 0x89 && b[1] === 0x50;
  var isWebp = b[8] === 0x57 && b[9] === 0x45; // WEBP
  return isJpeg || isPng || isWebp;
}

async function compress(buffer) {
  try {
    var sharp = require('sharp');
    var qualities = [85, 70, 55, 40];
    for (var i = 0; i < qualities.length; i++) {
      var out = await sharp(buffer).jpeg({ quality: qualities[i], progressive: true }).toBuffer();
      if (out.length <= 800000 || i === qualities.length - 1) return out;
    }
  } catch(e) {}
  return buffer;
}

exports.handler = async function(event) {
  var url = (event.queryStringParameters || {}).url || '';
  if (!url || !url.startsWith('https://imgs.vercapas.com/')) {
    return { statusCode: 400, body: 'Invalid URL' };
  }

  try {
    var img = null;

    // Try requested URL first
    try {
      img = await fetchImage(url);
    } catch(e) { img = null; }

    // If not valid and was full-size, try thumbnail
    if (!isValidImage(img) && !url.includes('/th/')) {
      var thumbUrl = url.replace(/\/covers\/([^/]+)\/(\d+)\//, '/covers/$1/$2/th/');
      try { img = await fetchImage(thumbUrl); } catch(e) { img = null; }
    }

    if (!isValidImage(img)) {
      // Return 302 redirect to a 1x1 transparent GIF so onerror fires
      return { statusCode: 404, body: 'Not found' };
    }

    var data = await compress(img.data);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      },
      body: data.toString('base64'),
      isBase64Encoded: true
    };

  } catch(e) {
    return { statusCode: 500, body: e.message };
  }
};
