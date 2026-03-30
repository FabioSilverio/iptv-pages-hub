export type PlaylistKind = 'xtream' | 'm3u'
export type EmbedPlatform = 'twitch' | 'kick'
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

  const primaryExtension = credentials.output === 'ts' ? 'ts' : 'm3u8'
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
