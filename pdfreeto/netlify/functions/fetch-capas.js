const https = require('https');
const http = require('http');

function fetchUrl(url, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    var client = url.startsWith('https') ? https : http;
    var opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-PT,pt;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      }
    };
    var req = client.get(url, opts, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        var loc = res.headers.location;
        if (loc.startsWith('/')) {
          var u = new URL(url);
          loc = u.protocol + '//' + u.host + loc;
        }
        res.resume();
        return fetchUrl(loc, redirects + 1).then(resolve).catch(reject);
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(Buffer.from(c)); });
      res.on('end', function() {
        var buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: buf.toString('latin1'), length: buf.length });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, function() { req.destroy(new Error('Timeout')); });
  });
}

exports.handler = async function(event) {
  var qs = event.queryStringParameters || {};
  var debugMode = qs.debug === '1';

  try {
    var result = await fetchUrl('https://www.vercapas.com/');
    var html = result.body;

    // DEBUG: return raw info
    if (debugMode) {
      var sample = html.substring(0, 3000);
      // Also find any cover image URLs
      var imgMatches = html.match(/imgs\.vercapas\.com\/covers\/[^\s"'<]+\.jpg/g) || [];
      var capaLinks = html.match(/\/capa\/[^"'\s]+\.html/g) || [];
      var h2s = html.match(/<h2[^>]*>[^<]*<\/h2>/g) || [];
      var dataSrcs = html.match(/data-src="[^"]+"/g) || [];
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          status: result.status,
          length: result.length,
          coverImages: imgMatches.slice(0, 10),
          capaLinks: capaLinks.slice(0, 10),
          h2s: h2s.slice(0, 10),
          dataSrcs: dataSrcs.slice(0, 5),
          htmlSample: sample
        }, null, 2)
      };
    }

    var sections = [];

    // STRATEGY 1: Try h2-based section splitting
    var h2Pattern = /<h2[^>]*>(.*?)<\/h2>/gi;
    var h2Match;
    var h2Positions = [];
    while ((h2Match = h2Pattern.exec(html)) !== null) {
      var title = h2Match[1].replace(/<[^>]+>/g, '').trim();
      if (title.length > 1 && title.length < 60) {
        h2Positions.push({ title: title, start: h2Match.index + h2Match[0].length });
      }
    }

    if (h2Positions.length > 0) {
      for (var i = 0; i < h2Positions.length; i++) {
        var secStart = h2Positions[i].start;
        var secEnd = i + 1 < h2Positions.length ? h2Positions[i + 1].start : html.length;
        var chunk = html.slice(secStart, secEnd);
        var pubs = extractPubs(chunk);
        if (pubs.length > 0) {
          sections.push({ title: h2Positions[i].title, pubs: pubs });
        }
      }
    }

    // STRATEGY 2: Try h3-based splitting if h2 didn't work
    if (sections.length === 0) {
      var h3Pattern = /<h3[^>]*>(.*?)<\/h3>/gi;
      var h3Match;
      var h3Positions = [];
      while ((h3Match = h3Pattern.exec(html)) !== null) {
        var t = h3Match[1].replace(/<[^>]+>/g, '').trim();
        if (t.length > 1 && t.length < 60) {
          h3Positions.push({ title: t, start: h3Match.index + h3Match[0].length });
        }
      }
      for (var j = 0; j < h3Positions.length; j++) {
        var s = h3Positions[j].start;
        var e = j + 1 < h3Positions.length ? h3Positions[j + 1].start : html.length;
        var pubs2 = extractPubs(html.slice(s, e));
        if (pubs2.length > 0) sections.push({ title: h3Positions[j].title, pubs: pubs2 });
      }
    }

    // STRATEGY 3: No sections — just grab ALL covers from the page
    if (sections.length === 0) {
      var allPubs = extractPubs(html);
      if (allPubs.length > 0) {
        sections.push({ title: 'Capas de Hoje', pubs: allPubs });
      }
    }

    // STRATEGY 4: Match cover links anywhere near cover images (looser)
    if (sections.length === 0) {
      var pubsLoose = extractPubsLoose(html);
      if (pubsLoose.length > 0) {
        sections.push({ title: 'Capas de Hoje', pubs: pubsLoose });
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=1800'
      },
      body: JSON.stringify({
        sections: sections,
        fetched: new Date().toISOString(),
        count: sections.reduce(function(a, s) { return a + s.pubs.length; }, 0),
        htmlLength: html.length
      })
    };

  } catch(e) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: e.message, sections: [], fetched: new Date().toISOString() })
    };
  }
};

function cleanTitle(t) {
  return (t || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s*-\s*\d{4}-\d{2}-\d{2}\s*$/, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '').trim();
}

function extractPubs(chunk) {
  var pubs = [];
  var seen = {};

  // Find all capa links in chunk
  var linkRe = /href="(\/capa\/([^"]+)\.html)"(?:[^>]*title="([^"]*)")?/gi;
  var lm;
  while ((lm = linkRe.exec(chunk)) !== null) {
    var href = 'https://www.vercapas.com' + lm[1];
    if (seen[href]) continue;

    var slug = lm[2];
    var titleAttr = cleanTitle(lm[3] || '');
    var name = titleAttr || slug.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });

    var dateM = (lm[3] || '').match(/(\d{4}-\d{2}-\d{2})/);
    var date = dateM ? dateM[1] : '';

    // Search for image near this link (within 800 chars before or after)
    var linkPos = lm.index;
    var nearby = chunk.slice(Math.max(0, linkPos - 400), linkPos + 800);

    var thumb = '';
    // Try src= with vercapas covers
    var imgM = nearby.match(/src="(https:\/\/imgs\.vercapas\.com\/covers\/[^"]+\.(?:jpg|png))"/i);
    if (imgM && !imgM[1].includes('grey.gif')) thumb = imgM[1];
    // Try data-src
    if (!thumb) {
      var dsM = nearby.match(/data-src="(https:\/\/imgs\.vercapas\.com\/covers\/[^"]+\.(?:jpg|png))"/i);
      if (dsM) thumb = dsM[1];
    }
    // Try data-original
    if (!thumb) {
      var doM = nearby.match(/data-original="(https:\/\/imgs\.vercapas\.com\/covers\/[^"]+\.(?:jpg|png))"/i);
      if (doM) thumb = doM[1];
    }

    seen[href] = true;
    pubs.push({ title: name, href: href, thumb: thumb, date: date });
  }
  return pubs;
}

function extractPubsLoose(html) {
  // Last resort: find ALL cover image URLs and pair with nearest capa link
  var pubs = [];
  var seen = {};

  var imgRe = /(https:\/\/imgs\.vercapas\.com\/covers\/([^/]+)\/\d+\/(?:th\/)?[^"'\s<]+\.(?:jpg|png))/gi;
  var im;
  while ((im = imgRe.exec(html)) !== null) {
    var imgUrl = im[1];
    var slug = im[2];
    if (imgUrl.includes('grey.gif')) continue;
    if (seen[slug]) continue;
    seen[slug] = true;

    // Nearby link
    var pos = im.index;
    var nearby = html.slice(Math.max(0, pos - 600), pos + 200);
    var linkM = nearby.match(/href="(\/capa\/[^"]+\.html)"(?:[^>]*title="([^"]*)")?/i);
    var href = linkM ? 'https://www.vercapas.com' + linkM[1] : 'https://www.vercapas.com/capa/' + slug + '.html';
    var name = linkM ? cleanTitle(linkM[2] || '') : slug.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    var dateM = imgUrl.match(/(\d{4}-\d{2}-\d{2})/);
    var date = dateM ? dateM[1] : '';
    var thumb = imgUrl.includes('/th/') ? imgUrl : imgUrl.replace(/\/covers\/([^/]+)\/(\d+)\//, '/covers/$1/$2/th/');

    pubs.push({ title: name, href: href, thumb: thumb, date: date });
  }
  return pubs;
}
