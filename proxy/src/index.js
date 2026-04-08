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

    if (url.pathname === '/youtube-status') {
      return handleYouTubeStatus(request, url)
    }

    if (url.pathname === '/youtube-resolve') {
      return handleYouTubeResolve(request, url)
    }

    if (url.pathname !== '/proxy') {
      return json(
        {
          ok: true,
          usage: '/proxy?url=http://origin/path or /kick-status?channel=xqc or /youtube-status?channel=@vaush',
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
      avatarUrl:
        data?.user?.profile_pic
        || data?.user?.profile_picture
        || data?.user?.profilePicture
        || '',
      displayName:
        data?.user?.username
        || data?.user?.display_name
        || data?.slug
        || channel,
    }, 200, request)
  } catch (error) {
    return json({
      live: false,
      label: 'Erro',
      detail: error instanceof Error ? error.message : 'Falha ao consultar a Kick.',
    }, 200, request)
  }
}

async function handleYouTubeStatus(request, url) {
  const channel = normalizeYouTubeChannel(String(url.searchParams.get('channel') || ''))
  if (!channel) {
    return json({ error: 'Missing channel query param.' }, 400, request)
  }

  try {
    const pageUrl = buildYouTubeLivePageUrl(channel)
    const response = await fetch(pageUrl, {
      headers: buildUpstreamHeaders(request.headers, new URL(pageUrl)),
      redirect: 'follow',
    })

    if (!response.ok) {
      throw new Error(`YouTube respondeu ${response.status}.`)
    }

    const html = await response.text()
    const watchLive = extractYouTubeWatchLive(html)
    if (watchLive?.videoId) {
      return json(
        {
          label: 'Ao vivo',
          state: 'online',
          detail: 'Live detectada na pagina oficial do video ao vivo do YouTube.',
          updatedAt: new Date().toISOString(),
          playbackUrl: buildYouTubeEmbedUrl(watchLive.videoId),
          watchUrl: `https://www.youtube.com/watch?v=${watchLive.videoId}`,
          avatarUrl: extractYouTubeAvatar(html),
          displayName: extractYouTubeDisplayName(html, channel),
        },
        200,
        request,
      )
    }

    const liveCard = extractYouTubeLiveCard(html)
    const isUpcoming = /"title":"(?:Live|Ao vivo)","selected":true[\s\S]{0,2500}"upcomingEventData"/.test(html)

    if (liveCard?.videoId && isCurrentYouTubeLiveCard(liveCard.details)) {
      return json(
        {
          label: 'Ao vivo',
          state: 'online',
          detail: 'Live detectada na aba oficial /live do canal no YouTube.',
          updatedAt: new Date().toISOString(),
          playbackUrl: buildYouTubeEmbedUrl(liveCard.videoId),
          watchUrl: `https://www.youtube.com/watch?v=${liveCard.videoId}`,
          avatarUrl: extractYouTubeAvatar(html),
          displayName: extractYouTubeDisplayName(html, channel),
        },
        200,
        request,
      )
    }

    return json(
      {
        label: isUpcoming ? 'Agendado' : 'Offline',
        state: 'offline',
        detail: isUpcoming
          ? 'O canal tem uma live agendada no YouTube, mas nao esta ao vivo agora.'
          : 'Canal sem live ao vivo agora no YouTube.',
        updatedAt: new Date().toISOString(),
        watchUrl: buildYouTubeWatchUrl(channel),
        avatarUrl: extractYouTubeAvatar(html),
        displayName: extractYouTubeDisplayName(html, channel),
      },
      200,
      request,
    )
  } catch (error) {
    return json(
      {
        label: 'Indisponivel',
        state: 'unknown',
        detail: error instanceof Error ? error.message : 'Nao foi possivel consultar o YouTube agora.',
        updatedAt: new Date().toISOString(),
        watchUrl: buildYouTubeWatchUrl(channel),
        displayName: channel,
      },
      200,
      request,
    )
  }
}

async function handleYouTubeResolve(request, url) {
  const input = String(url.searchParams.get('input') || '').trim()
  const normalized = normalizeYouTubeChannel(input)

  if (!normalized) {
    return json({ error: 'Missing input query param.' }, 400, request)
  }

  if (
    normalized.startsWith('@')
    || normalized.startsWith('channel/')
    || normalized.startsWith('c/')
    || normalized.startsWith('user/')
  ) {
    return json({ channel: normalized }, 200, request)
  }

  if (!normalized.startsWith('live/')) {
    return json({ channel: normalized }, 200, request)
  }

  try {
    const pageUrl = buildYouTubeLivePageUrl(normalized)
    const response = await fetch(pageUrl, {
      headers: buildUpstreamHeaders(request.headers, new URL(pageUrl)),
      redirect: 'follow',
    })

    if (!response.ok) {
      throw new Error(`YouTube respondeu ${response.status}.`)
    }

    const html = await response.text()
    const match = html.match(/"canonicalBaseUrl":"\/(@[^"]+|channel\/[^"]+|c\/[^"]+|user\/[^"]+)"/)
    return json({ channel: match?.[1] || normalized }, 200, request)
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : 'Nao consegui identificar o canal por esse link do YouTube.',
      },
      400,
      request,
    )
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

  if (requiresYoutubeHeaders(targetUrl)) {
    next.set('origin', 'https://www.youtube.com')
    next.set('referer', 'https://www.youtube.com/')
    next.set('accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
    next.set('accept-language', 'en-US,en;q=0.9')
    next.set('cache-control', 'no-cache')
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

function requiresYoutubeHeaders(targetUrl) {
  return /(^|\.)youtube\.com$/i.test(targetUrl.hostname) || /(^|\.)youtu\.be$/i.test(targetUrl.hostname)
}

function normalizeYouTubeChannel(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''

  if (trimmed.includes('youtube.com/')) {
    try {
      const url = new URL(trimmed)
      const path = url.pathname.replace(/\/+$/, '')
      if (path.startsWith('/@')) return path.slice(1)
      if (/^\/channel\/[^/]+$/i.test(path)) return path.slice(1)
      if (/^\/c\/[^/]+$/i.test(path)) return path.slice(1)
      if (/^\/user\/[^/]+$/i.test(path)) return path.slice(1)
      if (/^\/live\/[A-Za-z0-9_-]{11}$/i.test(path)) {
        return `live/${path.replace(/^\/live\//i, '')}`
      }
    } catch {
      return trimmed
    }
  }

  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`
}

function buildYouTubeLivePageUrl(channel) {
  const normalized = normalizeYouTubeChannel(channel)
  if (!normalized) return 'https://www.youtube.com'
  return normalized.startsWith('live/')
    ? `https://www.youtube.com/${normalized}?hl=en`
    : `https://www.youtube.com/${normalized}/live?hl=en`
}

function buildYouTubeWatchUrl(channel) {
  const normalized = normalizeYouTubeChannel(channel)
  if (!normalized) return 'https://www.youtube.com'
  return `https://www.youtube.com/${normalized}`
}

function buildYouTubeEmbedUrl(videoId) {
  return `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`
}

function extractYouTubeLiveCard(html) {
  const match = html.match(
    /"title":"(?:Live|Ao vivo)","selected":true,"content":\{"richGridRenderer":\{"contents":\[\{"richItemRenderer":\{"content":\{"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"([\s\S]{0,5000}?)"navigationEndpoint"/,
  )

  if (!match?.[1]) return null

  return {
    videoId: match[1],
    details: match[2] || '',
  }
}

function isCurrentYouTubeLiveCard(details) {
  const hasArchivedMeta = /"publishedTimeText":\{"simpleText":"(?:Streamed|Transmitido|Premiered|Estreou)/i.test(details)
  if (hasArchivedMeta) {
    return false
  }

  const hasWatchingNow = /"viewCountText":\{[\s\S]{0,220}"(?:watching|assistindo)/i.test(details)
  const hasLiveBadge =
    /BADGE_STYLE_TYPE_LIVE_NOW|"label":"LIVE NOW"|"label":"Ao vivo"/i.test(details)
  const hasStaticLength = /"lengthText":\{/i.test(details)

  return hasWatchingNow || (hasLiveBadge && !hasStaticLength)
}

function extractYouTubeWatchLive(html) {
  const isWatchPage = /window\['ytPageType'\]\s*=\s*"watch"|itemtype="http:\/\/schema\.org\/VideoObject"/i.test(html)
  if (!isWatchPage) {
    return null
  }

  const isLive =
    /itemprop="isLiveBroadcast"\s+content="True"/i.test(html)
    || /"is_viewed_live","value":"True"/i.test(html)
    || /"liveStreamability":\{/i.test(html)

  if (!isLive) {
    return null
  }

  const videoIdMatch =
    html.match(/window\['ytCommand'\]\s*=\s*\{[\s\S]{0,1200}"watchEndpoint":\{"videoId":"([A-Za-z0-9_-]{11})"/)
    || html.match(/<meta\s+property="og:video:url"\s+content="https:\/\/www\.youtube\.com\/embed\/([A-Za-z0-9_-]{11})"/i)
    || html.match(/<link\s+rel="shortlinkUrl"\s+href="https:\/\/youtu\.be\/([A-Za-z0-9_-]{11})"/i)

  if (!videoIdMatch?.[1]) {
    return null
  }

  return {
    videoId: videoIdMatch[1],
  }
}

function extractYouTubeAvatar(html) {
  const channelMetadataMatch = html.match(/"channelMetadataRenderer":\{[\s\S]{0,4000}?"avatar":\{"thumbnails":\[(.*?)\]\}/i)
  const avatarChunk = channelMetadataMatch?.[1] || ''
  const urlMatches = [...avatarChunk.matchAll(/"url":"(https:[^"]+)"/g)]
  const avatarUrl = urlMatches.at(-1)?.[1] || urlMatches[0]?.[1]

  return avatarUrl ? avatarUrl.replace(/\\u0026/g, '&') : ''
}

function extractYouTubeDisplayName(html, fallbackChannel) {
  const channelNameMatch = html.match(/"channelMetadataRenderer":\{[\s\S]{0,2000}?"title":"([^"]+)"/i)
  if (channelNameMatch?.[1]) {
    return channelNameMatch[1]
  }

  const metaMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)
  if (metaMatch?.[1]) {
    return metaMatch[1].replace(/\s*-\s*YouTube\s*$/i, '')
  }

  return fallbackChannel
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
