const https = require('https');
const http = require('http');

function fetchUrl(url, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    var client = url.startsWith('https') ? https : http;
    var opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Referer': 'https://www.vercapas.com/'
      }
    };
    client.get(url, opts, function(res) {
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
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var buf = Buffer.concat(chunks);
        // Try latin1 (ISO-8859-1) decoding — vercapas uses this
        resolve(buf.toString('latin1'));
      });
    }).on('error', reject).setTimeout(15000, function() { this.destroy(new Error('Timeout')); });
  });
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Latin1 Portuguese chars
    .replace(/\u00e7/g, 'ç').replace(/\u00e3/g, 'ã').replace(/\u00f5/g, 'õ')
    .replace(/\u00e9/g, 'é').replace(/\u00ea/g, 'ê').replace(/\u00e0/g, 'à')
    .replace(/\u00e2/g, 'â').replace(/\u00fa/g, 'ú').replace(/\u00f3/g, 'ó')
    .replace(/\u00f4/g, 'ô').replace(/\u00ed/g, 'í').replace(/\u00e1/g, 'á')
    .replace(/\u00c9/g, 'É').replace(/\u00ca/g, 'Ê').replace(/\u00c3/g, 'Ã')
    .replace(/\u00d5/g, 'Õ').replace(/\u00da/g, 'Ú').replace(/\u00d3/g, 'Ó');
}

exports.handler = async function(event) {
  // Debug mode: return raw HTML snippet
  var debug = event.queryStringParameters && event.queryStringParameters.debug;

  try {
    var html = await fetchUrl('https://www.vercapas.com/');

    if (debug) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' },
        body: html.substring(0, 5000)
      };
    }

    var sections = [];

    // Strategy 1: Find sections by h2, then find all cover links + images within each
    // vercapas uses: <li> with <a href="/capa/..."> containing two <img> tags
    // First img is grey.gif placeholder, second is the real thumbnail

    // Split HTML into section chunks by h2
    var parts = html.split(/<h2[^>]*>/i);

    for (var i = 1; i < parts.length; i++) {
      var part = parts[i];
      // Get section title (text before </h2>)
      var titleMatch = part.match(/^([^<]{1,60})<\/h2>/i);
      if (!titleMatch) continue;
      var sectionTitle = decodeEntities(titleMatch[1].trim());
      // Skip obvious non-section titles
      if (sectionTitle.length < 2 || sectionTitle.length > 50) continue;

      // Get section body (until next section or end of useful content)
      var body = part.substring(titleMatch[0].length);
      // Stop at next major structural element
      var stopIdx = body.search(/<\/?(?:footer|div\s+class="footer|div\s+id="footer)/i);
      if (stopIdx > 0) body = body.substring(0, stopIdx);

      var pubs = [];
      var seen = {};

      // Find all list items with cover links
      // Pattern: <li ...><a href="/capa/SLUG.html" ...title="NAME - DATE"...>...<img src="GREY"...><img src="REAL_IMG"...>
      var liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      var liMatch;

      while ((liMatch = liRegex.exec(body)) !== null) {
        var li = liMatch[1];

        // Find the capa link
        var linkMatch = li.match(/href="(\/capa\/[^"]+\.html)"[^>]*title="([^"]*)"/i);
        if (!linkMatch) {
          linkMatch = li.match(/href="(\/capa\/[^"]+\.html)"/i);
          if (!linkMatch) continue;
        }

        var href = 'https://www.vercapas.com' + linkMatch[1];
        var titleAttr = linkMatch[2] ? decodeEntities(linkMatch[2]) : '';

        // Extract name (remove date suffix)
        var name = titleAttr.replace(/\s*-\s*\d{4}-\d{2}-\d{2}\s*$/, '').trim();
        var dateMatch2 = titleAttr.match(/(\d{4}-\d{2}-\d{2})/);
        var date = dateMatch2 ? dateMatch2[1] : '';

        if (!name) {
          // Try to get name from link text
          var textMatch = li.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
          if (textMatch) name = textMatch[1].replace(/<[^>]+>/g, '').trim().split(/\s+/).slice(0,4).join(' ');
        }

        if (!name || seen[href]) continue;
        seen[href] = true;

        // Find real cover image (not grey.gif)
        var imgRegex = /src="(https:\/\/imgs\.vercapas\.com\/covers\/[^"]+\.(?:jpg|png))"/gi;
        var imgMatch;
        var thumb = '';
        while ((imgMatch = imgRegex.exec(li)) !== null) {
          if (!imgMatch[1].includes('grey.gif')) {
            thumb = imgMatch[1];
            break;
          }
        }

        // Also check data-src for lazy loading
        if (!thumb) {
          var dataMatch = li.match(/data-src="(https:\/\/imgs\.vercapas\.com\/covers\/[^"]+\.(?:jpg|png))"/i);
          if (dataMatch) thumb = dataMatch[1];
        }

        pubs.push({
          title: name,
          href: href,
          thumb: thumb,
          date: date
        });
      }

      if (pubs.length > 0) {
        sections.push({ title: sectionTitle, pubs: pubs });
      }
    }

    // Strategy 2 fallback: if no sections found, try simpler extraction
    if (sections.length === 0) {
      var fallbackPubs = [];
      var globalImgRegex = /href="(\/capa\/([^"]+)\.html)"[^>]*title="([^"]+)"[\s\S]{0,500}?src="(https:\/\/imgs\.vercapas\.com\/covers\/[^"]+\.(?:jpg|png))"/gi;
      var gMatch;
      var seenG = {};
      while ((gMatch = globalImgRegex.exec(html)) !== null) {
        var gHref = 'https://www.vercapas.com' + gMatch[1];
        if (seenG[gHref] || gMatch[4].includes('grey.gif')) continue;
        seenG[gHref] = true;
        var gTitle = decodeEntities(gMatch[3]).replace(/\s*-\s*\d{4}-\d{2}-\d{2}$/, '').trim();
        var gDate = gMatch[3].match(/(\d{4}-\d{2}-\d{2})$/);
        fallbackPubs.push({
          title: gTitle,
          href: gHref,
          thumb: gMatch[4],
          date: gDate ? gDate[1] : ''
        });
      }
      if (fallbackPubs.length > 0) {
        sections.push({ title: 'Capas de Hoje', pubs: fallbackPubs });
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
        count: sections.reduce(function(a, s) { return a + s.pubs.length; }, 0)
      })
    };

  } catch(e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: e.message, sections: [], fetched: new Date().toISOString() })
    };
  }
};
