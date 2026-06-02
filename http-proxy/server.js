import express from 'express'

const app = express()
const PORT = process.env.PORT || 8788

function buildCorsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin',
  }
}

function responseHeaders(extra = {}, upstreamHeaders) {
  const headers = new Headers(extra)
  if (upstreamHeaders) {
    for (const [key, value] of upstreamHeaders.entries()) {
      if (/^(content-length|transfer-encoding|content-security-policy|x-frame-options)$/i.test(key)) {
        continue
      }
      if (!headers.has(key)) headers.set(key, value)
    }
  }
  return headers
}

function buildProxyUrl(proxyOrigin, targetUrl) {
  return `${proxyOrigin}/proxy?url=${encodeURIComponent(targetUrl)}`
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

async function proxyRequest(req, res) {
  const target = String(req.query.url || '').trim()
  if (!target) {
    res.status(400).json({ error: 'Missing url query param.' })
    return
  }

  let targetUrl
  try {
    targetUrl = new URL(target)
  } catch {
    res.status(400).json({ error: 'Invalid target URL.' })
    return
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    res.status(400).json({ error: 'Only http and https are supported.' })
    return
  }

  const upstream = await fetchUpstream(targetUrl, req)
  const contentType = upstream.headers.get('content-type') || ''
  const proxyOrigin = `${req.protocol}://${req.get('host')}`

  const headers = responseHeaders(
    {
      ...buildCorsHeaders(req.headers.origin),
      'Cache-Control': 'no-store',
    },
    upstream.headers,
  )

  if (
    contentType.includes('application/vnd.apple.mpegurl') ||
    contentType.includes('application/x-mpegurl') ||
    targetUrl.pathname.endsWith('.m3u8')
  ) {
    const rawManifest = await upstream.text()
    const manifestBaseUrl = new URL(upstream.url || targetUrl.toString())
    const manifest = rewriteManifest(rawManifest, manifestBaseUrl, proxyOrigin)
    res.status(upstream.status)
    for (const [key, value] of headers.entries()) res.setHeader(key, value)
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
    res.send(manifest)
    return
  }

  res.status(upstream.status)
  for (const [key, value] of headers.entries()) res.setHeader(key, value)
  if (req.method === 'HEAD') {
    res.end()
    return
  }

  const body = upstream.body
  if (!body) {
    res.end()
    return
  }

  for await (const chunk of body) {
    res.write(chunk)
  }
  res.end()
}

async function fetchUpstream(targetUrl, req) {
  const headers = {
    Accept: req.headers.accept || '*/*',
    'Accept-Encoding': 'identity',
    'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
  }

  if (req.headers.range) {
    headers.Range = req.headers.range
  }

  const firstResponse = await fetch(targetUrl.toString(), {
    method: req.method === 'HEAD' ? 'GET' : req.method,
    headers,
    redirect: 'manual',
  })

  if (![301, 302, 303, 307, 308].includes(firstResponse.status)) {
    return firstResponse
  }

  const location = firstResponse.headers.get('location')
  if (!location) {
    return firstResponse
  }

  const redirectUrl = new URL(location, targetUrl)
  return fetch(redirectUrl.toString(), {
    method: 'GET',
    headers,
    redirect: 'manual',
  })
}

app.options('/proxy', (req, res) => {
  for (const [key, value] of Object.entries(buildCorsHeaders(req.headers.origin))) {
    res.setHeader(key, value)
  }
  res.status(204).end()
})

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'iptv-pages-hub-http-proxy' })
})

app.all('/proxy', (req, res) => {
  proxyRequest(req, res).catch((error) => {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Proxy failure.' })
  })
})

app.listen(PORT, () => {
  console.log(`IPTV HTTP proxy listening on ${PORT}`)
})
