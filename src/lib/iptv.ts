export type PlaylistKind = 'xtream' | 'm3u'
export type EmbedPlatform = 'twitch' | 'youtube' | 'kick'
export type LiveState = 'online' | 'offline' | 'unknown' | 'error'

export interface Channel {
  id: string
  name: string
  group: string
  streamUrl: string
  fallbackStreamUrl?: string
  logo?: string
  tvgId?: string
  categoryId?: string
}

export interface PlaylistSession {
  id: string
  kind: PlaylistKind
  label: string
  sourceLabel: string
  channels: Channel[]
  groups: string[]
  loadedAt: string
}

export interface XtreamCredentials {
  serverUrl: string
  username: string
  password: string
  output: 'auto' | 'm3u8' | 'ts'
  proxyUrl?: string
}

export interface M3UCredentials {
  url: string
}

export interface PersistedConnection {
  kind: PlaylistKind
  remember: boolean
  xtream: XtreamCredentials
  m3u: M3UCredentials
}

export interface EmbedStream {
  id: string
  platform: EmbedPlatform
  channel: string
  title: string
  statusEndpoint?: string
}

export interface EmbedStatus {
  label: string
  state: LiveState
  detail: string
  updatedAt: string
  playbackUrl?: string
  watchUrl?: string
}

export interface KickAppToken {
  accessToken: string
  expiresAt: string
}

interface XtreamCategory {
  category_id?: string
  category_name?: string
}

interface XtreamStream {
  stream_id?: number | string
  name?: string
  category_id?: string
  stream_icon?: string
  epg_channel_id?: string
  stream_type?: string
}

const FALLBACK_GROUP = 'Sem grupo'

export const TWITCH_STATUS_HELP =
  'Status oficial requer Client ID da Twitch e um token OAuth do navegador.'
export const YOUTUBE_STATUS_HELP =
  'O status do YouTube e lido pelo proxy a partir da pagina /live do canal, sem precisar de API key.'
export const KICK_STATUS_HELP =
  'Status da Kick usa o worker do app por padrao. Se quiser, voce ainda pode sobrescrever com Client ID e Client Secret locais.'

export function normalizeServerUrl(url: string) {
  return url.trim().replace(/\/+$/, '')
}

export function normalizeProxyUrl(url?: string) {
  return url?.trim().replace(/\/+$/, '') || ''
}

export function buildProxyUrl(proxyBase: string, targetUrl: string) {
  const base = normalizeProxyUrl(proxyBase)
  return `${base}/proxy?url=${encodeURIComponent(targetUrl)}`
}

function ensureBrowserSafeRemoteUrl(rawUrl: string, label: string) {
  const url = new URL(rawUrl)

  if (
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:' &&
    url.protocol === 'http:'
  ) {
    throw new Error(
      `${label} usa HTTP puro (${url.host}). O navegador bloqueia login HTTP dentro de uma pagina HTTPS.`,
    )
  }

  return url
}

async function parseJsonPayload(response: Response, label: string) {
  const rawText = await response.text()

  if (!rawText.trim()) {
    throw new Error(`${label} respondeu vazio. Verifique login, senha ou a API do provedor.`)
  }

  try {
    return JSON.parse(rawText) as unknown
  } catch {
    throw new Error(`${label} nao devolveu JSON valido para uso no navegador.`)
  }
}

export function normalizeGroupName(group?: string | null) {
  return group?.trim() || FALLBACK_GROUP
}

export function safeChannelName(name?: string | null) {
  return name?.trim() || 'Canal sem nome'
}

export function createChannelId(prefix: string, seed: string) {
  return `${prefix}:${seed}`
}

export function createPlaylistId(kind: PlaylistKind, label: string) {
  return `${kind}:${label.toLowerCase().replace(/\s+/g, '-')}`
}

export function describeSourceLabel(kind: PlaylistKind, value: string) {
  try {
    const url = new URL(value)
    return url.host
  } catch {
    return kind === 'xtream' ? 'Servidor Xtream' : 'Playlist remota'
  }
}

export function sortChannels(channels: Channel[]) {
  return [...channels].sort((left, right) => {
    const groupCompare = left.group.localeCompare(right.group, 'pt-BR')
    if (groupCompare !== 0) {
      return groupCompare
    }

    return left.name.localeCompare(right.name, 'pt-BR')
  })
}

export function listGroups(channels: Channel[]) {
  return Array.from(new Set(channels.map((channel) => channel.group))).sort((a, b) =>
    a.localeCompare(b, 'pt-BR'),
  )
}

export async function fetchXtreamPlaylist(
  credentials: XtreamCredentials,
  signal?: AbortSignal,
): Promise<PlaylistSession> {
  const serverUrl = normalizeServerUrl(credentials.serverUrl)
  const proxyUrl = normalizeProxyUrl(credentials.proxyUrl)

  if (!proxyUrl) {
    ensureBrowserSafeRemoteUrl(serverUrl, 'Esse servidor Xtream')
  }

  const params = new URLSearchParams({
    username: credentials.username.trim(),
    password: credentials.password.trim(),
  })

  const rawCategoriesUrl = `${serverUrl}/player_api.php?${params.toString()}&action=get_live_categories`
  const rawStreamsUrl = `${serverUrl}/player_api.php?${params.toString()}&action=get_live_streams`
  const categoriesUrl = proxyUrl ? buildProxyUrl(proxyUrl, rawCategoriesUrl) : rawCategoriesUrl
  const streamsUrl = proxyUrl ? buildProxyUrl(proxyUrl, rawStreamsUrl) : rawStreamsUrl

  const [categoriesResponse, streamsResponse] = await Promise.all([
    fetch(categoriesUrl, { signal }),
    fetch(streamsUrl, { signal }),
  ])

  if (!streamsResponse.ok) {
    throw new Error('Nao foi possivel carregar os canais do Xtream Codes.')
  }

  const categoryList = categoriesResponse.ok
    ? (await parseJsonPayload(categoriesResponse, 'A resposta de categorias do Xtream')) as XtreamCategory[]
    : []
  const streamList = (await parseJsonPayload(
    streamsResponse,
    'A resposta de canais do Xtream',
  )) as XtreamStream[]
  const categoryMap = new Map(
    categoryList.map((item) => [String(item.category_id ?? ''), item.category_name ?? FALLBACK_GROUP]),
  )

  const primaryExtension =
    credentials.output === 'm3u8' ? 'm3u8' : 'ts'
  const fallbackExtension =
    credentials.output === 'ts' ? 'm3u8' : 'ts'
  const channels = sortChannels(
    streamList
      .filter((item) => item.stream_id && item.stream_type !== 'radio')
      .map((item) => {
        const streamId = String(item.stream_id)
        const rawStreamUrl = `${serverUrl}/live/${encodeURIComponent(
          credentials.username.trim(),
        )}/${encodeURIComponent(credentials.password.trim())}/${streamId}.${primaryExtension}`
        const rawFallbackStreamUrl = `${serverUrl}/live/${encodeURIComponent(
          credentials.username.trim(),
        )}/${encodeURIComponent(credentials.password.trim())}/${streamId}.${fallbackExtension}`
        const streamUrl = proxyUrl ? buildProxyUrl(proxyUrl, rawStreamUrl) : rawStreamUrl
        const fallbackStreamUrl =
          primaryExtension === fallbackExtension
            ? undefined
            : proxyUrl
              ? buildProxyUrl(proxyUrl, rawFallbackStreamUrl)
              : rawFallbackStreamUrl

        return {
          id: createChannelId('xtream', streamId),
          name: safeChannelName(item.name),
          group: normalizeGroupName(categoryMap.get(String(item.category_id ?? ''))),
          streamUrl,
          fallbackStreamUrl,
          logo: item.stream_icon || undefined,
          tvgId: item.epg_channel_id || undefined,
          categoryId: item.category_id || undefined,
        }
      }),
  )

  return {
    id: createPlaylistId('xtream', serverUrl),
    kind: 'xtream',
    label: 'Xtream Codes',
    sourceLabel: describeSourceLabel('xtream', serverUrl),
    channels,
    groups: listGroups(channels),
    loadedAt: new Date().toISOString(),
  }
}

export async function parseM3UWithWorker(rawText: string) {
  return new Promise<Channel[]>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/m3u-parser.worker.ts', import.meta.url), {
      type: 'module',
    })

    worker.onmessage = (event: MessageEvent<Channel[]>) => {
      worker.terminate()
      resolve(sortChannels(event.data))
    }

    worker.onerror = () => {
      worker.terminate()
      reject(new Error('Falha ao processar a playlist M3U em background.'))
    }

    worker.postMessage(rawText)
  })
}

export async function fetchM3UPlaylist(
  credentials: M3UCredentials,
  signal?: AbortSignal,
): Promise<PlaylistSession> {
  const url = credentials.url.trim()
  ensureBrowserSafeRemoteUrl(url, 'Essa playlist M3U')
  const response = await fetch(url, { signal })

  if (!response.ok) {
    throw new Error('Nao foi possivel baixar a playlist M3U.')
  }

  const text = await response.text()
  const channels = await parseM3UWithWorker(text)

  return {
    id: createPlaylistId('m3u', credentials.url),
    kind: 'm3u',
    label: 'M3U URL',
    sourceLabel: describeSourceLabel('m3u', credentials.url),
    channels,
    groups: listGroups(channels),
    loadedAt: new Date().toISOString(),
  }
}

export function buildTwitchAuthUrl(clientId: string) {
  const redirectUri = `${window.location.origin}${window.location.pathname}`
  const state = crypto.randomUUID()

  window.sessionStorage.setItem('twitch_oauth_state', state)

  const params = new URLSearchParams({
    client_id: clientId.trim(),
    redirect_uri: redirectUri,
    response_type: 'token',
    state,
  })

  return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`
}

export function takeTwitchTokenFromHash() {
  if (!window.location.hash.includes('access_token=')) {
    return null
  }

  const hash = new URLSearchParams(window.location.hash.slice(1))
  const state = hash.get('state')
  const expectedState = window.sessionStorage.getItem('twitch_oauth_state')

  if (!state || !expectedState || state !== expectedState) {
    return null
  }

  const accessToken = hash.get('access_token')
  window.sessionStorage.removeItem('twitch_oauth_state')
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  return accessToken
}

export async function fetchTwitchStatuses(
  channels: string[],
  clientId: string,
  accessToken: string,
): Promise<Record<string, EmbedStatus>> {
  if (!channels.length) {
    return {}
  }

  const params = new URLSearchParams()
  channels.forEach((channel) => params.append('user_login', channel))

  const response = await fetch(`https://api.twitch.tv/helix/streams?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': clientId,
    },
  })

  if (!response.ok) {
    throw new Error('Falha ao consultar o status da Twitch.')
  }

  const payload = (await response.json()) as {
    data?: Array<{ user_login?: string; title?: string; viewer_count?: number }>
  }
  const liveMap = new Map(
    (payload.data ?? []).map((item) => [
      item.user_login?.toLowerCase() ?? '',
      {
        label: 'On air',
        state: 'online' as const,
        detail: item.title
          ? `${item.title}${item.viewer_count ? ` • ${item.viewer_count} viewers` : ''}`
          : 'Live agora',
        updatedAt: new Date().toISOString(),
      },
    ]),
  )

  return Object.fromEntries(
    channels.map((channel) => {
      const key = channel.toLowerCase()
      const online = liveMap.get(key)

      return [
        key,
        online || {
          label: 'Offline',
          state: 'offline' as const,
          detail: 'Canal offline no ultimo refresh.',
          updatedAt: new Date().toISOString(),
        },
      ]
    }),
  )
}

function normalizeYoutubeChannel(value: string) {
  const trimmed = value.trim()
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
        const liveSlug = path.replace(/^\/live\//i, '')
        return `live/${liveSlug}`
      }
    } catch {
      return trimmed
    }
  }
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`
}

function buildYoutubeLivePageUrl(channel: string) {
  const normalized = normalizeYoutubeChannel(channel)
  if (!normalized) return ''
  return normalized.startsWith('live/')
    ? `https://www.youtube.com/${normalized}?hl=en`
    : `https://www.youtube.com/${normalized}/live?hl=en`
}

function buildYoutubeWatchUrl(channel: string) {
  const normalized = normalizeYoutubeChannel(channel)
  if (!normalized) return 'https://www.youtube.com'
  return normalized.startsWith('live/')
    ? `https://www.youtube.com/${normalized}`
    : `https://www.youtube.com/${normalized}`
}

function buildYoutubeEmbedUrl(videoId: string) {
  return `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1`
}

export async function fetchYoutubeStatuses(
  channels: string[],
  proxyBase: string,
): Promise<Record<string, EmbedStatus>> {
  if (!channels.length) {
    return {}
  }

  const entries = await Promise.all(
    channels.map(async (channel) => {
      try {
        const livePageUrl = buildYoutubeLivePageUrl(channel)
        const watchUrl = buildYoutubeWatchUrl(channel)
        const response = await fetch(buildProxyUrl(proxyBase, livePageUrl), {
          headers: {
            Accept: 'text/html',
            'User-Agent': 'Mozilla/5.0',
          },
        })

        if (!response.ok) {
          throw new Error(`YouTube respondeu ${response.status}.`)
        }

        const html = await response.text()
        const liveMatch = html.match(
          /"title":"(?:Live|Ao vivo)","selected":true,"content":\{"richGridRenderer":\{"contents":\[\{"richItemRenderer":\{"content":\{"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"/,
        )

        if (liveMatch?.[1]) {
          const videoId = liveMatch[1]
          return [
            channel.toLowerCase(),
            {
              label: 'Ao vivo',
              state: 'online' as const,
              detail: 'Live detectada na aba oficial /live do canal no YouTube.',
              updatedAt: new Date().toISOString(),
              playbackUrl: buildYoutubeEmbedUrl(videoId),
              watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
            } satisfies EmbedStatus,
          ] as const
        }

        const isUpcoming = /"title":"(?:Live|Ao vivo)","selected":true[\s\S]{0,2500}"upcomingEventData"/.test(html)
        return [
          channel.toLowerCase(),
          {
            label: isUpcoming ? 'Agendado' : 'Offline',
            state: 'offline' as const,
            detail: isUpcoming
              ? 'O canal tem uma live agendada no YouTube, mas nao esta ao vivo agora.'
              : 'Canal sem live ao vivo agora no YouTube.',
            updatedAt: new Date().toISOString(),
            watchUrl,
          } satisfies EmbedStatus,
        ] as const
      } catch (error) {
        return [
          channel.toLowerCase(),
          {
            label: 'Erro',
            state: 'error' as const,
            detail: error instanceof Error ? error.message : YOUTUBE_STATUS_HELP,
            updatedAt: new Date().toISOString(),
            watchUrl: buildYoutubeWatchUrl(channel),
          } satisfies EmbedStatus,
        ] as const
      }
    }),
  )

  return Object.fromEntries(entries)
}

export async function resolveYoutubeChannelInput(
  rawInput: string,
  proxyBase: string,
): Promise<string> {
  const normalized = normalizeYoutubeChannel(rawInput)

  if (!normalized) {
    throw new Error('Cole um canal do YouTube usando @handle, URL do canal ou URL /live.')
  }

  if (
    normalized.startsWith('@')
    || normalized.startsWith('channel/')
    || normalized.startsWith('c/')
    || normalized.startsWith('user/')
  ) {
    return normalized
  }

  if (normalized.startsWith('live/')) {
    const response = await fetch(buildProxyUrl(proxyBase, buildYoutubeLivePageUrl(normalized)), {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0',
      },
    })

    if (!response.ok) {
      throw new Error('Nao consegui identificar o canal por esse link do YouTube.')
    }

    const html = await response.text()
    const match = html.match(/"canonicalBaseUrl":"\/(@[^"]+|channel\/[^"]+|c\/[^"]+|user\/[^"]+)"/)
    if (match?.[1]) {
      return match[1]
    }
  }

  return normalized
}

export async function fetchKickAppAccessToken(
  clientId: string,
  clientSecret: string,
  proxyBase?: string,
): Promise<KickAppToken> {
  const targetUrl = 'https://id.kick.com/oauth/token'
  const requestUrl = proxyBase ? buildProxyUrl(proxyBase, targetUrl) : targetUrl
  const body = new URLSearchParams({
    client_id: clientId.trim(),
    client_secret: clientSecret.trim(),
    grant_type: 'client_credentials',
  })

  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  })

  if (!response.ok) {
    throw new Error('Falha ao gerar o App Access Token da Kick.')
  }

  const payload = (await response.json()) as {
    access_token?: string
    expires_in?: number
  }

  if (!payload.access_token) {
    throw new Error('A Kick nao devolveu um access token valido.')
  }

  return {
    accessToken: payload.access_token,
    expiresAt: new Date(Date.now() + Math.max((payload.expires_in || 3600) - 60, 60) * 1000).toISOString(),
  }
}

export async function fetchKickStatuses(
  channels: string[],
  accessToken: string,
  proxyBase?: string,
): Promise<Record<string, EmbedStatus>> {
  if (!channels.length) {
    return {}
  }

  const entries = await Promise.all(
    channels.map(async (channel) => {
      const targetUrl = `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(channel)}`
      const requestUrl = proxyBase ? buildProxyUrl(proxyBase, targetUrl) : targetUrl
      const response = await fetch(requestUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error('Falha ao consultar o status da Kick.')
      }

      const payload = (await response.json()) as {
        data?: Array<{
          slug?: string
          stream?: {
            is_live?: boolean
            viewer_count?: number
          }
          stream_title?: string
        }>
      }

      return payload.data?.[0]
    }),
  )

  const liveMap = new Map(
    entries.filter(Boolean).map((item) => {
      const key = item!.slug?.toLowerCase() ?? ''
      const isLive = Boolean(item!.stream?.is_live)
      const viewerCount = item!.stream?.viewer_count

      return [
        key,
        {
          label: isLive ? 'Ao vivo' : 'Offline',
          state: isLive ? ('online' as const) : ('offline' as const),
          detail: isLive
            ? item!.stream_title
              ? `${item!.stream_title}${viewerCount ? ` • ${viewerCount} assistindo` : ''}`
              : 'Canal ao vivo na Kick.'
            : 'Canal offline no ultimo refresh.',
          updatedAt: new Date().toISOString(),
        },
      ]
    }),
  )

  return Object.fromEntries(
    channels.map((channel) => {
      const key = channel.toLowerCase()
      return [
        key,
        liveMap.get(key) || {
          label: 'Offline',
          state: 'offline' as const,
          detail: 'Canal offline no ultimo refresh.',
          updatedAt: new Date().toISOString(),
        },
      ]
    }),
  )
}

export async function fetchCustomStatus(endpoint: string): Promise<EmbedStatus> {
  const response = await fetch(endpoint)

  if (!response.ok) {
    throw new Error('Falha ao consultar o endpoint de status customizado.')
  }

  const payload = (await response.json()) as {
    live?: boolean
    detail?: string
    label?: string
  }
  const isLive = Boolean(payload.live)

  return {
    label: payload.label || (isLive ? 'On air' : 'Offline'),
    state: isLive ? 'online' : 'offline',
    detail: payload.detail || (isLive ? 'Status informado por endpoint externo.' : 'Canal offline.'),
    updatedAt: new Date().toISOString(),
  }
}

export async function fetchKickStatusesFromWorker(
  channels: string[],
  proxyBase: string,
): Promise<Record<string, EmbedStatus>> {
  if (!channels.length) {
    return {}
  }

  const entries = await Promise.all(
    channels.map(async (channel) => {
      const endpoint = `${normalizeProxyUrl(proxyBase)}/kick-status?channel=${encodeURIComponent(channel)}`
      return [channel.toLowerCase(), await fetchCustomStatus(endpoint)] as const
    }),
  )

  return Object.fromEntries(entries)
}
