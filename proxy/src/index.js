export default {
  async fetch(request) {
    const url = new URL(request.url)
    const isHeadRequest = request.method === 'HEAD'

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(request),
      })
    }

    if (url.pathname !== '/proxy') {
      return json(
        {
          ok: true,
          usage: '/proxy?url=http://origin/path',
        },
        200,
        request,
      )
    }

    const target = url.searchParams.get('url')
    if (!target) {
      return json({ error: 'Missing url query param.' }, 400, request)
    }

    let targetUrl
    try {
      targetUrl = new URL(target)
    } catch {
      return json({ error: 'Invalid target URL.' }, 400, request)
    }

    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      return json({ error: 'Only http and https targets are supported.' }, 400, request)
    }

    const upstream = await fetch(targetUrl.toString(), {
      method: isHeadRequest ? 'GET' : request.method,
      headers: filterRequestHeaders(request.headers),
      body: canHaveBody(request.method) ? request.body : undefined,
      redirect: 'follow',
    })

    const contentType = upstream.headers.get('content-type') || ''
    const isManifest =
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegurl') ||
      targetUrl.pathname.endsWith('.m3u8')

    if (isManifest) {
      const rawManifest = await upstream.text()
      const manifest = rewriteManifest(rawManifest, targetUrl, url.origin)
      return new Response(manifest, {
        status: upstream.status,
        headers: responseHeaders(request, {
          'content-type': 'application/vnd.apple.mpegurl',
          'cache-control': 'no-store',
        }, upstream.headers),
      })
    }

    return new Response(isHeadRequest ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders(request, {
        'content-type': contentType || 'application/octet-stream',
        'cache-control': 'no-store',
      }, upstream.headers),
    })
  },
}

function canHaveBody(method) {
  return !['GET', 'HEAD'].includes(method.toUpperCase())
}

function filterRequestHeaders(headers) {
  const next = new Headers()

  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase()
    if (['host', 'origin', 'referer', 'cf-connecting-ip', 'x-forwarded-proto'].includes(lower)) {
      continue
    }
    next.set(key, value)
  }

  return next
}

function rewriteManifest(rawManifest, targetUrl, proxyOrigin) {
  const lines = rawManifest.split(/\r?\n/)

  return lines
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line

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

function buildProxyUrl(proxyOrigin, targetUrl) {
  return `${proxyOrigin}/proxy?url=${encodeURIComponent(targetUrl)}`
}

function responseHeaders(request, extra = {}, upstreamHeaders) {
  const headers = new Headers(extra)
  const cors = corsHeaders(request)
  const passthroughHeaders = [
    'accept-ranges',
    'content-length',
    'content-range',
    'etag',
    'last-modified',
    'expires',
  ]

  if (upstreamHeaders) {
    passthroughHeaders.forEach((key) => {
      const value = upstreamHeaders.get(key)
      if (value) headers.set(key, value)
    })
  }

  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value)
  }

  return headers
}

function corsHeaders(request) {
  return {
    'access-control-allow-origin': request.headers.get('origin') || '*',
    'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
    'access-control-allow-headers': request.headers.get('access-control-request-headers') || '*',
  }
}

function json(payload, status, request) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: responseHeaders(request, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }),
  })
}
