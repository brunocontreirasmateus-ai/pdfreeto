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
    }).on('error', reject).setTimeout(15000, function() { this.destroy(new Error('Timeout')); });
  });
}

async function compress(buffer, maxBytes) {
  try {
    var sharp = require('sharp');
    maxBytes = maxBytes || 800000; // 800KB

    // Start with quality 85, reduce until under maxBytes
    var qualities = [85, 70, 55, 40];
    for (var i = 0; i < qualities.length; i++) {
      var result = await sharp(buffer)
        .jpeg({ quality: qualities[i], progressive: true })
        .toBuffer();
      if (result.length <= maxBytes || i === qualities.length - 1) {
        return result;
      }
    }
  } catch(e) {
    // sharp not available — return original
    return buffer;
  }
  return buffer;
}

exports.handler = async function(event) {
  var url = (event.queryStringParameters || {}).url || '';

  // Only allow imgs.vercapas.com
  if (!url || !url.startsWith('https://imgs.vercapas.com/')) {
    return { statusCode: 400, body: 'Invalid URL' };
  }

  try {
    // Try full-size first, fall back to thumbnail
    var img;
    var isFull = !url.includes('/th/');

    try {
      img = await fetchImage(url);
      if (img.status !== 200 || img.data.length < 500) throw new Error('Bad response');
    } catch(e) {
      if (isFull) {
        // Try thumbnail instead
        var thumb = url.replace(/\/covers\/([^/]+)\/(\d+)\//, '/covers/$1/$2/th/');
        img = await fetchImage(thumb);
      } else {
        throw e;
      }
    }

    if (!img || img.data.length < 500) {
      return { statusCode: 404, body: 'Image not found' };
    }

    // Compress to max 800KB
    var compressed = await compress(img.data, 800000);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=3600',
        'Access-Control-Allow-Origin': '*',
        'X-Original-Size': img.data.length.toString(),
        'X-Compressed-Size': compressed.length.toString()
      },
      body: compressed.toString('base64'),
      isBase64Encoded: true
    };

  } catch(e) {
    return { statusCode: 500, body: e.message };
  }
};
