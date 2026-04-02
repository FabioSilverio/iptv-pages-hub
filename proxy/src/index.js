export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const isHeadRequest = request.method === 'HEAD'

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(request),
      })
    }

    if (url.pathname === '/kick-status') {
      return handleKickStatus(request, env, url)
    }

    if (url.pathname !== '/proxy') {
      return json(
        {
          ok: true,
          usage: '/proxy?url=http://origin/path or /kick-status?channel=xqc',
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
      headers: buildUpstreamHeaders(request.headers, targetUrl),
      body: canHaveBody(request.method) ? request.body : undefined,
      redirect: 'follow',
    })

    const contentType = upstream.headers.get('content-type') || ''
    const isManifest =
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegurl') ||
      targetUrl.pathname.endsWith('.m3u8')
    const isDashManifest =
      contentType.includes('application/dash+xml') ||
      targetUrl.pathname.endsWith('.mpd')

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

    if (isDashManifest) {
      const rawManifest = await upstream.text()
      const manifest = rewriteDashManifest(rawManifest, targetUrl, url.origin)
      return new Response(manifest, {
        status: upstream.status,
        headers: responseHeaders(request, {
          'content-type': 'application/dash+xml; charset=utf-8',
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

async function handleKickStatus(request, env, url) {
  const channel = String(url.searchParams.get('channel') || '').trim().toLowerCase()
  if (!channel) {
    return json({ error: 'Missing channel query param.' }, 400, request)
  }

  if (!env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET) {
    return json({
      live: false,
      label: 'Sem auth',
      detail: 'Worker sem credenciais da Kick configuradas.',
    }, 200, request)
  }

  try {
    const token = await getKickAccessToken(env)
    const endpoint = new URL('https://api.kick.com/public/v1/channels')
    endpoint.searchParams.append('slug', channel)

    const response = await fetch(endpoint.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`Kick status respondeu ${response.status}.`)
    }

    const payload = await response.json()
    const data = Array.isArray(payload?.data) ? payload.data[0] || {} : {}
    const isLive = Boolean(data?.stream?.is_live)
    const viewers = Number(data?.stream?.viewer_count || 0)
    const title = typeof data?.stream_title === 'string' ? data.stream_title : ''

    return json({
      live: isLive,
      label: isLive ? 'Ao vivo' : 'Offline',
      detail: isLive
        ? title
          ? `${title}${viewers ? ` • ${viewers} assistindo` : ''}`
          : 'Canal ao vivo na Kick.'
        : 'Canal offline no ultimo refresh.',
    }, 200, request)
  } catch (error) {
    return json({
      live: false,
      label: 'Erro',
      detail: error instanceof Error ? error.message : 'Falha ao consultar a Kick.',
    }, 200, request)
  }
}

let kickTokenCache = {
  accessToken: '',
  expiresAt: 0,
}

async function getKickAccessToken(env) {
  if (kickTokenCache.accessToken && kickTokenCache.expiresAt > Date.now() + 30_000) {
    return kickTokenCache.accessToken
  }

  const body = new URLSearchParams({
    client_id: String(env.KICK_CLIENT_ID),
    client_secret: String(env.KICK_CLIENT_SECRET),
    grant_type: 'client_credentials',
  })

  const response = await fetch('https://id.kick.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  })

  if (!response.ok) {
    throw new Error(`Kick token respondeu ${response.status}.`)
  }

  const payload = await response.json()
  if (!payload?.access_token) {
    throw new Error('Kick nao devolveu access token.')
  }

  kickTokenCache = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max((payload.expires_in || 3600) - 60, 60) * 1000,
  }

  return kickTokenCache.accessToken
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

function buildUpstreamHeaders(headers, targetUrl) {
  const next = filterRequestHeaders(headers)

  if (requiresNbcHeaders(targetUrl)) {
    next.set('origin', 'https://www.nbc.com')
    next.set('referer', 'https://www.nbc.com/')
    next.set('accept', '*/*')
    next.set(
      'user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    )
  }

  return next
}

function requiresNbcHeaders(targetUrl) {
  return /(^|\.)cssott\.com$/i.test(targetUrl.hostname)
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

function rewriteDashManifest(rawManifest, targetUrl, proxyOrigin) {
  let manifest = rawManifest.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (_, baseValue) => {
    const absoluteUrl = new URL(baseValue.trim(), targetUrl).toString()
    return `<BaseURL>${buildProxyUrl(proxyOrigin, absoluteUrl)}</BaseURL>`
  })

  manifest = manifest.replace(/\b(media|initialization|sourceURL|index)="([^"]+)"/g, (_, attribute, value) => {
    const absoluteUrl = new URL(value, targetUrl).toString()
    return `${attribute}="${buildProxyUrl(proxyOrigin, absoluteUrl)}"`
  })

  return manifest
}

function buildProxyUrl(proxyOrigin, targetUrl) {
  const encodedTarget = encodeURIComponent(targetUrl).replace(/%24/g, '$')
  return `${proxyOrigin}/proxy?url=${encodedTarget}`
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
