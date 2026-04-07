function buildProxyUrl(proxyOrigin, targetUrl) {
  return `${proxyOrigin}/api/proxy?url=${encodeURIComponent(targetUrl)}`
}

function rewriteManifest(rawManifest, targetUrl, proxyOrigin) {
  return rawManifest
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#EXTM3U') || trimmed.startsWith('#EXT-X-ENDLIST')) return line

      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uriValue) => {
          const absoluteUrl = new URL(uriValue, targetUrl).toString()
          return `URI="${buildProxyUrl(proxyOrigin, absoluteUrl)}"`
        })
      }

      const absoluteUrl = new URL(trimmed, targetUrl).toString()
      return buildProxyUrl(proxyOrigin, absoluteUrl)
    })
    .join('\n')
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '*'
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    Vary: 'Origin',
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders)
    res.end()
    return
  }

  const target = String(req.query.url || '').trim()
  if (!target) {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Missing url query param.' }))
    return
  }

  let targetUrl
  try {
    targetUrl = new URL(target)
  } catch {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid target URL.' }))
    return
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Only http and https are supported.' }))
    return
  }

  try {
    const upstream = await fetch(targetUrl.toString(), {
      method: req.method === 'HEAD' ? 'GET' : 'GET',
      headers: {
        Accept: req.headers.accept || '*/*',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        Referer: targetUrl.origin,
        Origin: targetUrl.origin,
      },
      redirect: 'follow',
    })

    const contentType = upstream.headers.get('content-type') || ''
    const proto = req.headers['x-forwarded-proto'] || 'https'
    const host = req.headers['x-forwarded-host'] || req.headers.host
    const proxyOrigin = `${proto}://${host}`

    const isManifest =
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegurl') ||
      targetUrl.pathname.endsWith('.m3u8')

    if (isManifest) {
      const rawManifest = await upstream.text()
      const manifest = rewriteManifest(rawManifest, targetUrl, proxyOrigin)
      res.writeHead(upstream.status, {
        ...corsHeaders,
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
      })
      res.end(manifest)
      return
    }

    const buffer = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, {
      ...corsHeaders,
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    res.end(buffer)
  } catch (error) {
    res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Proxy failure.' }))
  }
}
