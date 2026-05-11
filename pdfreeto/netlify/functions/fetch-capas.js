const https = require('https');

function get(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-PT,pt;q=0.9',
      }
    };
    https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('latin1');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

exports.handler = async function(event) {
  try {
    const html = await get('https://www.vercapas.com/');

    // Extract sections and publications
    const sections = [];
    
    // Split by h2 sections
    const sectionRegex = /<h2[^>]*>(.*?)<\/h2>([\s\S]*?)(?=<h2|<footer|$)/gi;
    let sectionMatch;
    
    while ((sectionMatch = sectionRegex.exec(html)) !== null) {
      const sectionTitle = sectionMatch[1].replace(/<[^>]+>/g,'').trim();
      const sectionHtml = sectionMatch[2];
      
      // Skip nav sections
      if (sectionTitle.length > 40) continue;
      
      const pubs = [];
      
      // Find list items with links and images
      const itemRegex = /<li[^>]*>[\s\S]*?<a\s+href="([^"]*capa[^"]*)"[^>]*title="([^"]*)"[\s\S]*?<img[^>]+src="(https:\/\/imgs\.vercapas\.com\/covers\/[^"]+\.(?:jpg|png))"[^>]*>/gi;
      let itemMatch;
      
      while ((itemMatch = itemRegex.exec(sectionHtml)) !== null) {
        const href = itemMatch[1];
        const title = itemMatch[2].replace(/\s*-\s*\d{4}-\d{2}-\d{2}\s*$/, '').trim();
        const imgSrc = itemMatch[3];
        
        // Skip grey.gif placeholders, only use real cover images
        if (imgSrc.includes('grey.gif')) continue;
        
        // Extract date from title or img URL
        const dateMatch = itemMatch[2].match(/(\d{4}-\d{2}-\d{2})/) || imgSrc.match(/(\d{4}-\d{2}-\d{2})/);
        const date = dateMatch ? dateMatch[1] : '';
        
        // Convert thumbnail to full size (remove /th/)
        const fullImg = imgSrc.replace(/\/th\//, '/');
        
        pubs.push({
          title: title,
          href: href.startsWith('http') ? href : 'https://www.vercapas.com' + href,
          thumb: imgSrc,
          img: fullImg,
          date: date
        });
      }
      
      if (pubs.length > 0) {
        sections.push({ title: sectionTitle, pubs });
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600'
      },
      body: JSON.stringify({ sections, fetched: new Date().toISOString() })
    };

  } catch(e) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: e.message, sections: [] })
    };
  }
};
