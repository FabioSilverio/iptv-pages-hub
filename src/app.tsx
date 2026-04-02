import type Hls from 'hls.js'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  buildProxyUrl,
  buildTwitchAuthUrl,
  type Channel,
  fetchCustomStatus,
  fetchKickAppAccessToken,
  fetchKickStatuses,
  fetchKickStatusesFromWorker,
  fetchM3UPlaylist,
  fetchTwitchStatuses,
  fetchXtreamPlaylist,
  KICK_STATUS_HELP,
  takeTwitchTokenFromHash,
  TWITCH_STATUS_HELP,
  type EmbedStatus,
  type EmbedStream,
  type LiveState,
  type M3UCredentials,
  type PersistedConnection,
  type PlaylistSession,
  type XtreamCredentials,
} from './lib/iptv'

const CONNECTION_KEY = 'iptv-pages-hub.connection'
const EMBEDS_KEY = 'iptv-pages-hub.embeds'
const SETTINGS_KEY = 'iptv-pages-hub.settings'
const LAST_CHANNEL_KEY = 'iptv-pages-hub.last-channel'
const FAVORITES_KEY = 'iptv-pages-hub.favorites'
const FORM_STATE_KEY = 'iptv-pages-hub.form-state'
const ACTIVE_SURFACE_KEY = 'iptv-pages-hub.active-surface'
const SELECTED_EMBED_KEY = 'iptv-pages-hub.selected-embed'
const SHOW_LIVE_NOW_KEY = 'iptv-pages-hub.show-live-now'
const DEFAULT_XTREAM_PROXY_URL = 'https://iptv-pages-hub-proxy.fabiogsilverio.workers.dev'
const INITIAL_CHANNEL_BATCH = 180
const CHANNEL_BATCH_STEP = 240

type MediaSurface = 'iptv' | 'twitch' | 'kick' | 'news'

interface NewsLink {
  id: string
  name: string
  href: string
  note: string
  source: string
  embedUrl?: string
  streamUrl?: string
}

interface MarketQuote {
  id: string
  label: string
  value: string
  change: string
  trend: 'up' | 'down' | 'flat'
}

interface AppSettings {
  rememberConnection: boolean
  twitchClientId: string
  twitchAccessToken: string
  kickClientId: string
  kickClientSecret: string
  kickAppAccessToken: string
  kickAppTokenExpiresAt: string
}

interface PersistedFormState {
  sourceTab: 'xtream' | 'm3u'
  xtream: XtreamCredentials
  m3u: M3UCredentials
}

interface ConnectionTransferBundle {
  version: 1
  sourceTab: 'xtream' | 'm3u'
  xtream: XtreamCredentials
  m3u: M3UCredentials
}

const defaultXtream: XtreamCredentials = {
  serverUrl: '',
  username: '',
  password: '',
  output: 'auto',
  proxyUrl: DEFAULT_XTREAM_PROXY_URL,
}
const defaultM3U: M3UCredentials = { url: '' }
const defaultSettings: AppSettings = {
  rememberConnection: true,
  twitchClientId: '',
  twitchAccessToken: '',
  kickClientId: '',
  kickClientSecret: '',
  kickAppAccessToken: '',
  kickAppTokenExpiresAt: '',
}

function mergeSettings(value?: Partial<AppSettings> | null): AppSettings {
  return { ...defaultSettings, ...(value || {}) }
}
const embedDefaults: EmbedStream[] = [
  { id: 'default:twitch:destiny', platform: 'twitch', channel: 'destiny', title: 'destiny' },
  { id: 'default:twitch:anythingelse', platform: 'twitch', channel: 'anythingelse', title: 'anythingelse' },
  { id: 'default:kick:sneako', platform: 'kick', channel: 'sneako', title: 'sneako' },
  { id: 'default:kick:imreallyimportant', platform: 'kick', channel: 'imreallyimportant', title: 'imreallyimportant' },
]
const newsLinks: NewsLink[] = [
  {
    id: 'bbc-news',
    name: 'BBC News',
    href: 'https://vs-hls-push-ww-live.akamaized.net/x=4/i=urn:bbc:pips:service:bbc_news_channel_hd/t=3840/v=pv14/b=5070016/main.m3u8',
    note: 'Feed direto da BBC via Akamai, tocando no player leve do proprio site.',
    source: 'BBC / Akamai',
    streamUrl: 'https://vs-hls-push-ww-live.akamaized.net/x=4/i=urn:bbc:pips:service:bbc_news_channel_hd/t=3840/v=pv14/b=5070016/main.m3u8',
  },
  {
    id: 'sky-news',
    name: 'Sky News',
    href: 'https://news.sky.com/watch-live',
    note: 'Feed HLS oficial da Sky News tocando direto no player do site.',
    source: 'Sky News',
    streamUrl: 'https://nnaa-skynews-61cza.fast.nbcuni.com/live/master.m3u8',
  },
  {
    id: 'nbc-news-now',
    name: 'NBC News NOW',
    href: 'https://www.nbcnews.com/now',
    note: 'Feed HLS oficial da NBC News NOW tocando direto no player do site.',
    source: 'NBC News',
    streamUrl: 'https://nnaa-nbcnn-lzaj01.fast.nbcuni.com/live/master.m3u8',
  },
  {
    id: 'cbs-news-247',
    name: 'CBS News 24/7',
    href: 'https://www.cbsnews.com/video/live-cbsnews/',
    note: 'Feed oficial da CBS News 24/7 tocando direto no player do site.',
    source: 'CBS News',
    streamUrl: 'https://news20e7hhcb.airspace-cdn.cbsivideo.com/index.m3u8',
  },
  {
    id: 'al-jazeera-english',
    name: 'Al Jazeera English',
    href: 'https://www.aljazeera.com/video/live',
    note: 'Feed ao vivo da Al Jazeera English tocando no player leve do site.',
    source: 'Al Jazeera',
    streamUrl: 'https://live-hls-web-aje-fa.getaj.net/AJE/index.m3u8',
  },
  {
    id: 'bloomberg-us',
    name: 'Bloomberg US',
    href: 'https://www.bloomberg.com/live',
    note: 'Feed oficial ao vivo da Bloomberg Television US.',
    source: 'Bloomberg',
    streamUrl: 'https://www.bloomberg.com/media-manifest/streams/phoenix-us.m3u8',
  },
]

const marketItems = [
  { symbol: 'BRL=X', id: 'usd-brl', label: 'USD/BRL', digits: 4 },
  { symbol: '^BVSP', id: 'ibov', label: 'Ibov', digits: 0 },
  { symbol: '^DJI', id: 'dow', label: 'Dow', digits: 0 },
  { symbol: '^IXIC', id: 'nasdaq', label: 'Nasdaq', digits: 0 },
  { symbol: '^VIX', id: 'vix', label: 'VIX', digits: 2 },
  { symbol: '^FTSE', id: 'ftse', label: 'FTSE', digits: 0 },
  { symbol: '^GDAXI', id: 'dax', label: 'DAX', digits: 0 },
  { symbol: '^FCHI', id: 'cac', label: 'CAC', digits: 0 },
] as const

function readJson<T>(key: string, fallback: T) {
  try {
    const stored = window.localStorage.getItem(key)
    return stored ? (JSON.parse(stored) as T) : fallback
  } catch {
    return fallback
  }
}

function saveJson<T>(key: string, value: T) {
  window.localStorage.setItem(key, JSON.stringify(value))
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

function statusTone(state: LiveState, platform?: 'twitch' | 'kick') {
  if (state === 'online') return classNames('status-chip', 'online', platform)
  if (state === 'offline') return classNames('status-chip', 'offline', platform)
  if (state === 'error') return classNames('status-chip', 'error', platform)
  return classNames('status-chip', 'unknown', platform)
}

function feedPillTone(platform?: 'twitch' | 'kick', active = false) {
  return classNames('feed-pill', 'button-pill', platform, active && 'active')
}

function isTokenFresh(expiresAt?: string) {
  if (!expiresAt) return false
  const expiry = Date.parse(expiresAt)
  return Number.isFinite(expiry) && expiry > Date.now() + 30_000
}

function buildKickEmbedUrl(channel: string) {
  return `https://player.kick.com/${channel}?autoplay=false&muted=false`
}

function buildTwitchEmbedUrl(channel: string) {
  const parent = window.location.hostname || 'localhost'
  return `https://player.twitch.tv/?channel=${channel}&parent=${parent}&muted=false`
}

function formatMarketValue(value: number, digits: number) {
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

function formatMarketPercent(value: number) {
  const signal = value > 0 ? '+' : value < 0 ? '' : ''
  return `${signal}${value.toFixed(2)}%`
}

function hasHttpUrl(value: string) {
  return value.trim().toLowerCase().startsWith('http://')
}

function toHttpsUrl(value: string) {
  return value.trim().replace(/^http:\/\//i, 'https://')
}

function formatXtreamError(error: unknown, serverUrl: string) {
  if (hasHttpUrl(serverUrl) && window.location.protocol === 'https:') {
    return `GitHub Pages abriu em HTTPS, mas esse Xtream esta em HTTP (${serverUrl.trim()}). O navegador bloqueia esse login. Tente a versao https:// do servidor. Se o provedor so responder em HTTP, vai precisar de proxy ou backend.`
  }
  if (error instanceof TypeError) {
    return 'Falha de rede ao consultar o Xtream. O servidor pode estar offline, sem CORS ou recusando acesso do navegador.'
  }
  return error instanceof Error ? error.message : 'Falha ao carregar o Xtream Codes.'
}

function formatM3UError(error: unknown, url: string) {
  if (hasHttpUrl(url) && window.location.protocol === 'https:') {
    return `Essa M3U esta em HTTP (${url.trim()}) e foi bloqueada por mixed content dentro do GitHub Pages. Use https:// ou um proxy.`
  }
  if (error instanceof TypeError) {
    return 'Falha de rede ao baixar a M3U. O host pode estar offline ou sem CORS para navegador.'
  }
  return error instanceof Error ? error.message : 'Falha ao carregar a M3U.'
}

function withDefaultProxy(credentials: XtreamCredentials) {
  return { ...defaultXtream, ...credentials, proxyUrl: credentials.proxyUrl?.trim() || DEFAULT_XTREAM_PROXY_URL }
}

function mergeM3U(credentials?: Partial<M3UCredentials> | null) {
  return { ...defaultM3U, ...(credentials || {}) }
}

function isReadyXtream(credentials: XtreamCredentials) {
  return Boolean(credentials.serverUrl.trim() && credentials.username.trim() && credentials.password.trim())
}

function isReadyM3U(credentials: M3UCredentials) {
  return Boolean(credentials.url.trim())
}

function extractTargetStreamUrl(streamUrl: string) {
  try {
    const url = new URL(streamUrl)
    const nested = url.searchParams.get('url')
    return nested ? decodeURIComponent(nested) : streamUrl
  } catch {
    return streamUrl
  }
}

function isLikelyHlsStream(streamUrl: string) {
  const target = extractTargetStreamUrl(streamUrl).toLowerCase()
  return target.includes('.m3u8') || target.includes('.m3u')
}

function isLikelyTsStream(streamUrl: string) {
  return extractTargetStreamUrl(streamUrl).toLowerCase().includes('.ts')
}

function replaceStreamExtension(streamUrl: string, nextExtension: 'm3u8' | 'ts') {
  try {
    const url = new URL(streamUrl)
    const nested = url.searchParams.get('url')

    if (nested) {
      const decoded = decodeURIComponent(nested).replace(/\.(m3u8|ts)(?=($|\?))/i, `.${nextExtension}`)
      url.searchParams.set('url', decoded)
      return url.toString()
    }

    return streamUrl.replace(/\.(m3u8|ts)(?=($|\?))/i, `.${nextExtension}`)
  } catch {
    return streamUrl.replace(/\.(m3u8|ts)(?=($|\?))/i, `.${nextExtension}`)
  }
}

function buildPlaybackSources(channel: Channel) {
  const primaryIsHls = isLikelyHlsStream(channel.streamUrl)
  const fallbackIsTs = Boolean(channel.fallbackStreamUrl && isLikelyTsStream(channel.fallbackStreamUrl))
  const orderedSources = primaryIsHls && fallbackIsTs
    ? [
        channel.fallbackStreamUrl,
        channel.streamUrl,
        replaceStreamExtension(channel.streamUrl, 'ts'),
        replaceStreamExtension(channel.streamUrl, 'm3u8'),
      ]
    : [
        channel.streamUrl,
        channel.fallbackStreamUrl,
        isLikelyHlsStream(channel.streamUrl) ? replaceStreamExtension(channel.streamUrl, 'ts') : undefined,
        isLikelyTsStream(channel.streamUrl) ? replaceStreamExtension(channel.streamUrl, 'm3u8') : undefined,
      ]

  const sources = orderedSources.filter((value): value is string => Boolean(value))

  return Array.from(new Set(sources)).map((url) => ({
    url,
    engine: isLikelyHlsStream(url) ? 'hls' : isLikelyTsStream(url) ? 'mpegts' : 'native',
  }))
}

async function attemptPlayback(video: HTMLVideoElement, stateOnBlocked: string) {
  try {
    await video.play()
    return 'Ao vivo'
  } catch {
    return stateOnBlocked
  }
}

export function App() {
  const [sourceTab, setSourceTab] = useState<'xtream' | 'm3u'>('xtream')
  const [xtream, setXtream] = useState<XtreamCredentials>(defaultXtream)
  const [m3u, setM3U] = useState<M3UCredentials>(defaultM3U)
  const [settings, setSettings] = useState<AppSettings>(() => mergeSettings(readJson<Partial<AppSettings> | null>(SETTINGS_KEY, null)))
  const [playlist, setPlaylist] = useState<PlaylistSession | null>(null)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(() => window.localStorage.getItem(LAST_CHANNEL_KEY))
  const [searchTerm, setSearchTerm] = useState('')
  const [groupFilter, setGroupFilter] = useState('Todos')
  const [favorites, setFavorites] = useState<string[]>(() => readJson(FAVORITES_KEY, [] as string[]))
  const [embeds, setEmbeds] = useState<EmbedStream[]>(() => readJson(EMBEDS_KEY, embedDefaults))
  const [embedDraft, setEmbedDraft] = useState<EmbedStream>({ id: '', platform: 'twitch', channel: '', title: '', statusEndpoint: '' })
  const [statusMap, setStatusMap] = useState<Record<string, EmbedStatus>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [transferMessage, setTransferMessage] = useState('')
  const [playerError, setPlayerError] = useState('')
  const [playerState, setPlayerState] = useState('Pronto para tocar')
  const [visibleCount, setVisibleCount] = useState(INITIAL_CHANNEL_BATCH)
  const [clockTick, setClockTick] = useState(() => Date.now())
  const [marketQuotes, setMarketQuotes] = useState<MarketQuote[]>([])
  const [activeSurface, setActiveSurface] = useState<MediaSurface>(
    () => readJson<MediaSurface>(ACTIVE_SURFACE_KEY, 'iptv'),
  )
  const [selectedNewsId, setSelectedNewsId] = useState(newsLinks[0].id)
  const [selectedEmbedId, setSelectedEmbedId] = useState<string | null>(
    () => window.localStorage.getItem(SELECTED_EMBED_KEY),
  )
  const [showConnectionPanel, setShowConnectionPanel] = useState(true)
  const [showLiveNowPanel, setShowLiveNowPanel] = useState(
    () => readJson<boolean>(SHOW_LIVE_NOW_KEY, false),
  )
  const [showIptvPanel, setShowIptvPanel] = useState(true)
  const [showTwitchPanel, setShowTwitchPanel] = useState(true)
  const [showKickPanel, setShowKickPanel] = useState(true)
  const [showNewsPanel, setShowNewsPanel] = useState(true)
  const [newsStripLeftReady, setNewsStripLeftReady] = useState(false)
  const [newsStripRightReady, setNewsStripRightReady] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const newsStripRef = useRef<HTMLDivElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  const mpegtsRef = useRef<{
    attachMediaElement: (mediaElement: HTMLMediaElement) => void
    detachMediaElement: () => void
    destroy: () => void
    load: () => void
    play: () => Promise<void> | void
    pause: () => void
    unload: () => void
    on: (event: string, listener: (...args: unknown[]) => void) => void
  } | null>(null)

  const channels = playlist?.channels ?? []
  const favoriteIds = useMemo(() => new Set(favorites), [favorites])
  const visibleChannels = useMemo(
    () =>
      channels
        .filter((channel) => {
          const matchesGroup = groupFilter === 'Todos' || channel.group === groupFilter
          const search = searchTerm.trim().toLowerCase()
          const matchesSearch =
            !search ||
            channel.name.toLowerCase().includes(search) ||
            channel.group.toLowerCase().includes(search) ||
            channel.tvgId?.toLowerCase().includes(search)
          return matchesGroup && matchesSearch
        })
        .sort((left, right) => {
          const leftFavorite = favoriteIds.has(left.id) ? 1 : 0
          const rightFavorite = favoriteIds.has(right.id) ? 1 : 0
          if (leftFavorite !== rightFavorite) return rightFavorite - leftFavorite
          const groupCompare = left.group.localeCompare(right.group, 'pt-BR')
          if (groupCompare !== 0) return groupCompare
          return left.name.localeCompare(right.name, 'pt-BR')
        }),
    [channels, favoriteIds, groupFilter, searchTerm],
  )
  const displayedChannels = useMemo(
    () => visibleChannels.slice(0, visibleCount),
    [visibleChannels, visibleCount],
  )
  const twitchEmbeds = useMemo(
    () => embeds.filter((item) => item.platform === 'twitch'),
    [embeds],
  )
  const kickEmbeds = useMemo(
    () => embeds.filter((item) => item.platform === 'kick'),
    [embeds],
  )
  const sortEmbedsByStatus = (items: EmbedStream[]) =>
    [...items].sort((left, right) => {
      const leftState = statusMap[left.channel.toLowerCase()]?.state
      const rightState = statusMap[right.channel.toLowerCase()]?.state
      const leftScore = leftState === 'online' ? 2 : leftState === 'offline' ? 1 : 0
      const rightScore = rightState === 'online' ? 2 : rightState === 'offline' ? 1 : 0

      if (leftScore !== rightScore) return rightScore - leftScore
      return left.title.localeCompare(right.title, 'pt-BR')
    })
  const sortedTwitchEmbeds = useMemo(
    () => sortEmbedsByStatus(twitchEmbeds),
    [statusMap, twitchEmbeds],
  )
  const sortedKickEmbeds = useMemo(
    () => sortEmbedsByStatus(kickEmbeds),
    [kickEmbeds, statusMap],
  )
  const liveEmbeds = useMemo(
    () =>
      [...sortedTwitchEmbeds, ...sortedKickEmbeds].filter(
        (item) => statusMap[item.channel.toLowerCase()]?.state === 'online',
      ),
    [sortedKickEmbeds, sortedTwitchEmbeds, statusMap],
  )
  const onlineTwitchCount = useMemo(
    () => sortedTwitchEmbeds.filter((item) => statusMap[item.channel.toLowerCase()]?.state === 'online').length,
    [sortedTwitchEmbeds, statusMap],
  )
  const onlineKickCount = useMemo(
    () => sortedKickEmbeds.filter((item) => statusMap[item.channel.toLowerCase()]?.state === 'online').length,
    [sortedKickEmbeds, statusMap],
  )
  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === selectedChannelId) ?? visibleChannels[0] ?? null,
    [channels, selectedChannelId, visibleChannels],
  )
  const activeEmbed = useMemo(() => {
    const pool = activeSurface === 'twitch' ? sortedTwitchEmbeds : activeSurface === 'kick' ? sortedKickEmbeds : []
    return pool.find((item) => item.id === selectedEmbedId) ?? pool[0] ?? null
  }, [activeSurface, selectedEmbedId, sortedKickEmbeds, sortedTwitchEmbeds])
  const activeFeedItems = useMemo(
    () => activeSurface === 'twitch' ? sortedTwitchEmbeds : activeSurface === 'kick' ? sortedKickEmbeds : [],
    [activeSurface, sortedKickEmbeds, sortedTwitchEmbeds],
  )
  const selectedNewsLink = useMemo(
    () => newsLinks.find((item) => item.id === selectedNewsId) ?? newsLinks[0],
    [selectedNewsId],
  )
  const selectedNewsPlayback = useMemo<Channel | null>(() => {
    if (!selectedNewsLink.streamUrl) return null

    return {
      id: `news:${selectedNewsLink.id}`,
      name: selectedNewsLink.name,
      group: 'Noticias',
      streamUrl: buildProxyUrl(DEFAULT_XTREAM_PROXY_URL, selectedNewsLink.streamUrl),
    }
  }, [selectedNewsLink])
  const selectedPlaybackChannel = useMemo<Channel | null>(() => {
    if (activeSurface === 'iptv') return selectedChannel
    if (activeSurface === 'news') return selectedNewsPlayback
    return null
  }, [activeSurface, selectedChannel, selectedNewsPlayback])
  const dashboardTimes = useMemo(() => {
    const now = new Date(clockTick)
    const zones = [
      ['Brasil', 'America/Sao_Paulo'],
      ['Londres', 'Europe/London'],
      ['Chicago', 'America/Chicago'],
      ['Paris', 'Europe/Paris'],
      ['LA', 'America/Los_Angeles'],
      ['NY', 'America/New_York'],
    ] as const

    return zones.map(([label, timeZone]) => ({
      label,
      value: new Intl.DateTimeFormat('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone,
      }).format(now),
    }))
  }, [clockTick])
  const hasMoreChannels = displayedChannels.length < visibleChannels.length
  const xtreamNeedsHttps = hasHttpUrl(xtream.serverUrl) && !xtream.proxyUrl?.trim() && window.location.protocol === 'https:'
  const xtreamHttpsSuggestion = xtreamNeedsHttps ? toHttpsUrl(xtream.serverUrl) : ''

  function syncNewsStripState() {
    const node = newsStripRef.current

    if (!node || activeSurface !== 'news') {
      setNewsStripLeftReady(false)
      setNewsStripRightReady(false)
      return
    }

    const maxScroll = Math.max(0, node.scrollWidth - node.clientWidth)
    const canScroll = maxScroll > 8
    setNewsStripLeftReady(canScroll && node.scrollLeft > 8)
    setNewsStripRightReady(canScroll && node.scrollLeft < maxScroll - 8)
  }

  function scrollNewsStrip(direction: 'left' | 'right') {
    const node = newsStripRef.current
    if (!node) return

    node.scrollBy({
      left: (direction === 'right' ? 1 : -1) * Math.max(220, node.clientWidth * 0.68),
      behavior: 'smooth',
    })
  }

  useEffect(() => {
    setVisibleCount(INITIAL_CHANNEL_BATCH)
  }, [playlist?.id, groupFilter, searchTerm])

  useEffect(() => {
    setClockTick(Date.now())
    const interval = window.setInterval(() => setClockTick(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    let isActive = true

    const loadMarketQuotes = async () => {
      try {
        const targetUrl =
          'https://query1.finance.yahoo.com/v7/finance/spark?symbols=BRL%3DX,%5EBVSP,%5EDJI,%5EIXIC,%5EVIX,%5EFTSE,%5EGDAXI,%5EFCHI&range=1d&interval=5m'
        const requestUrl = buildProxyUrl(DEFAULT_XTREAM_PROXY_URL, targetUrl)
        const response = await fetch(requestUrl, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'Mozilla/5.0',
          },
        })

        if (!response.ok) {
          throw new Error('Falha ao carregar painel de mercado.')
        }

        const payload = (await response.json()) as {
          spark?: {
            result?: Array<{
              symbol?: string
              response?: Array<{
                meta?: {
                  regularMarketPrice?: number
                  previousClose?: number
                }
              }>
            }>
          }
        }

        const bySymbol = new Map(
          (payload.spark?.result || []).map((entry) => [entry.symbol || '', entry.response?.[0]?.meta || {}]),
        )

        const nextQuotes = marketItems.reduce<MarketQuote[]>((items, item) => {
            const meta = bySymbol.get(item.symbol)
            const price = Number(meta?.regularMarketPrice)
            const previous = Number(meta?.previousClose)

            if (!Number.isFinite(price) || !Number.isFinite(previous) || previous === 0) {
              return items
            }

            const percent = ((price - previous) / previous) * 100
            items.push({
              id: item.id,
              label: item.label,
              value: formatMarketValue(price, item.digits),
              change: formatMarketPercent(percent),
              trend: percent > 0.02 ? 'up' as const : percent < -0.02 ? 'down' as const : 'flat' as const,
            })
            return items
          }, [])

        if (isActive) {
          setMarketQuotes(nextQuotes)
        }
      } catch {
        if (isActive) {
          setMarketQuotes([])
        }
      }
    }

    void loadMarketQuotes()
    const interval = window.setInterval(() => void loadMarketQuotes(), 300000)

    return () => {
      isActive = false
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    const hashToken = takeTwitchTokenFromHash()
    if (hashToken) {
      setSettings((current) => {
        const next = { ...current, twitchAccessToken: hashToken }
        saveJson(SETTINGS_KEY, next)
        return next
      })
    }

    const storedDraft = readJson<PersistedFormState | null>(FORM_STATE_KEY, null)
    const storedConnection = readJson<PersistedConnection | null>(CONNECTION_KEY, null)

    const initialSourceTab = storedDraft?.sourceTab || (storedConnection?.remember ? storedConnection.kind : 'xtream')
    const initialXtream = withDefaultProxy(storedDraft?.xtream || (storedConnection?.remember ? storedConnection.xtream : defaultXtream))
    const initialM3U = mergeM3U(storedDraft?.m3u || (storedConnection?.remember ? storedConnection.m3u : defaultM3U))

    setSourceTab(initialSourceTab)
    setXtream(initialXtream)
    setM3U(initialM3U)

    if (!storedConnection?.remember) return
    if (initialSourceTab === 'xtream' && isReadyXtream(initialXtream)) void connectXtream(initialXtream, false)
    if (initialSourceTab === 'm3u' && isReadyM3U(initialM3U)) void connectM3U(initialM3U, false)
  }, [])

  useEffect(() => saveJson(EMBEDS_KEY, embeds), [embeds])
  useEffect(() => saveJson(SETTINGS_KEY, settings), [settings])
  useEffect(() => saveJson(FAVORITES_KEY, favorites), [favorites])
  useEffect(() => saveJson(ACTIVE_SURFACE_KEY, activeSurface), [activeSurface])
  useEffect(() => saveJson(SHOW_LIVE_NOW_KEY, showLiveNowPanel), [showLiveNowPanel])
  useEffect(() => {
    if (activeSurface !== 'news') {
      syncNewsStripState()
      return
    }

    const node = newsStripRef.current
    if (!node) {
      syncNewsStripState()
      return
    }

    const handleScroll = () => syncNewsStripState()
    const handleResize = () => syncNewsStripState()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null

    node.addEventListener('scroll', handleScroll, { passive: true })
    observer?.observe(node)
    window.addEventListener('resize', handleResize)
    window.requestAnimationFrame(syncNewsStripState)

    return () => {
      node.removeEventListener('scroll', handleScroll)
      observer?.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [activeSurface, selectedNewsId])
  useEffect(() => {
    saveJson<PersistedFormState>(FORM_STATE_KEY, { sourceTab, xtream, m3u })
  }, [m3u, sourceTab, xtream])

  useEffect(() => {
    if (selectedChannel?.id) window.localStorage.setItem(LAST_CHANNEL_KEY, selectedChannel.id)
  }, [activeSurface, selectedChannel?.id])
  useEffect(() => {
    if (selectedEmbedId) {
      window.localStorage.setItem(SELECTED_EMBED_KEY, selectedEmbedId)
      return
    }

    window.localStorage.removeItem(SELECTED_EMBED_KEY)
  }, [selectedEmbedId])

  useEffect(() => {
    if (activeSurface === 'twitch' && !twitchEmbeds.length) {
      if (kickEmbeds.length) {
        setActiveSurface('kick')
        setSelectedEmbedId(kickEmbeds[0].id)
      } else {
        setActiveSurface('iptv')
      }
      return
    }

    if (activeSurface === 'kick' && !kickEmbeds.length) {
      if (twitchEmbeds.length) {
        setActiveSurface('twitch')
        setSelectedEmbedId(twitchEmbeds[0].id)
      } else {
        setActiveSurface('iptv')
      }
      return
    }

    if ((activeSurface === 'twitch' || activeSurface === 'kick') && activeEmbed) {
      setSelectedEmbedId(activeEmbed.id)
    }
  }, [activeEmbed, activeSurface, kickEmbeds, twitchEmbeds])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !selectedPlaybackChannel) return
    const media: HTMLVideoElement = video

    if (activeSurface === 'iptv' && media.dataset.initialMuteApplied !== 'true') {
      media.defaultMuted = true
      media.muted = true
      media.dataset.initialMuteApplied = 'true'
    }

    let cancelled = false
    let suppressMediaError = false
    const playbackSources = buildPlaybackSources(selectedPlaybackChannel)
    let sourceAttempt = 0
    let successLocked = false
    let fallbackTimer = 0

    setPlayerError('')
    setPlayerState('Conectando stream...')

    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }
    if (mpegtsRef.current) {
      mpegtsRef.current.pause()
      mpegtsRef.current.unload()
      mpegtsRef.current.detachMediaElement()
      mpegtsRef.current.destroy()
      mpegtsRef.current = null
    }

    media.pause()
    media.removeAttribute('src')
    media.load()

    const onWaiting = () => setPlayerState('Aguardando buffer...')
    const onPlaying = () => setPlayerState('Ao vivo')
    const onStalled = () => setPlayerState('Reconectando...')
    const onLoadedMetadata = () => {
      if (activeSurface !== 'news') return
      for (const track of Array.from(media.textTracks || [])) {
        track.mode = 'disabled'
      }
    }
    const onCanPlay = () => {
      window.clearTimeout(fallbackTimer)
      successLocked = true
      setPlayerState((current) => (current === 'Ao vivo' ? current : 'Stream pronta'))
    }
    const onError = () => {
      if (suppressMediaError || cancelled) return
      void trySource(sourceAttempt + 1, 'O canal falhou no modo atual, tentando outro formato...')
    }

    media.addEventListener('waiting', onWaiting)
    media.addEventListener('playing', onPlaying)
    media.addEventListener('stalled', onStalled)
    media.addEventListener('loadedmetadata', onLoadedMetadata)
    media.addEventListener('canplay', onCanPlay)
    media.addEventListener('error', onError)

    const cleanupPlayers = () => {
      window.clearTimeout(fallbackTimer)
      suppressMediaError = true
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
      if (mpegtsRef.current) {
        mpegtsRef.current.pause()
        mpegtsRef.current.unload()
        mpegtsRef.current.detachMediaElement()
        mpegtsRef.current.destroy()
        mpegtsRef.current = null
      }
        media.pause()
        media.removeAttribute('src')
        media.load()
      window.setTimeout(() => {
        suppressMediaError = false
      }, 0)
    }

    const finishFailure = (message: string) => {
      window.clearTimeout(fallbackTimer)
      successLocked = false
      setPlayerError(message)
      setPlayerState('Falha no player')
    }

    async function trySource(sourceIndex: number, failureReason?: string): Promise<void> {
      const source = playbackSources[sourceIndex]
      if (!source) {
        finishFailure(
          failureReason || 'Nao foi possivel abrir esta stream nem com os fallbacks disponiveis.',
        )
        return
      }

      sourceAttempt = sourceIndex
      successLocked = false
      cleanupPlayers()
      if (cancelled) return

      setPlayerState(
        source.engine === 'hls'
          ? sourceIndex === 0
            ? 'Abrindo HLS otimizado...'
            : 'HLS falhou, tentando fallback TS...'
          : source.engine === 'mpegts'
            ? sourceIndex === 0
              ? 'Abrindo stream TS otimizada...'
              : 'Tentando fallback TS...'
            : 'Tentando modo nativo...',
      )

      fallbackTimer = window.setTimeout(() => {
        if (cancelled || successLocked || sourceAttempt !== sourceIndex) return
        void trySource(
          sourceIndex + 1,
          'O provedor nao respondeu a tempo no formato atual. Tentando outro formato...',
        )
      }, source.engine === 'mpegts' ? 14000 : 12000)

      if (source.engine === 'hls') {
        const { default: HlsClient } = await import('hls.js')
        if (cancelled) return

        if (!HlsClient.isSupported()) {
          void trySource(sourceIndex + 1, 'HLS nao disponivel aqui. Mudando para outro formato...')
          return
        }

        let retriedNetwork = false
        const hls = new HlsClient({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 30,
          liveSyncDurationCount: 4,
          liveMaxLatencyDurationCount: 12,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          manifestLoadingTimeOut: 15000,
          levelLoadingTimeOut: 15000,
          fragLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: 4,
          levelLoadingMaxRetry: 4,
          fragLoadingMaxRetry: 5,
        })

        hlsRef.current = hls
        hls.attachMedia(media)
        hls.on(HlsClient.Events.MEDIA_ATTACHED, () => hls.loadSource(source.url))
        hls.on(HlsClient.Events.MANIFEST_PARSED, async () => {
          window.clearTimeout(fallbackTimer)
          successLocked = true
          const nextState = await attemptPlayback(media, 'Clique em play para iniciar')
          if (!cancelled) setPlayerState(nextState)
        })
        hls.on(HlsClient.Events.ERROR, async (_, data) => {
          if (!data.fatal) return

            if (data.type === HlsClient.ErrorTypes.NETWORK_ERROR && !retriedNetwork) {
              retriedNetwork = true
              setPlayerState('Reconectando HLS...')
              hls.startLoad()
              return
          }

            if (data.type === HlsClient.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError()
              return
            }

          void trySource(
            sourceIndex + 1,
            `HLS recusado: ${data.details || 'erro fatal no stream.'}`,
          )
        })
        return
      }

      if (source.engine === 'mpegts') {
        const imported = await import('mpegts.js')
        const mpegts = (imported as unknown as { default?: Record<string, unknown> })?.default ?? imported
        const moduleApi = mpegts as {
          getFeatureList?: () => { mseLivePlayback?: boolean }
          createPlayer?: (
            mediaDataSource: { type: string; isLive: boolean; url: string; cors: boolean },
            config: Record<string, unknown>,
          ) => {
            attachMediaElement: (mediaElement: HTMLMediaElement) => void
            detachMediaElement: () => void
            destroy: () => void
            load: () => void
            play: () => Promise<void> | void
            pause: () => void
            unload: () => void
            on: (event: string, listener: (...args: unknown[]) => void) => void
          }
        }

        if (!moduleApi.getFeatureList?.().mseLivePlayback || !moduleApi.createPlayer) {
          void trySource(sourceIndex + 1, 'TS otimizado nao disponivel neste navegador.')
          return
        }

        const player = moduleApi.createPlayer(
          {
            type: 'mse',
            isLive: true,
            url: source.url,
            cors: true,
          },
          {
            enableWorker: true,
            enableStashBuffer: true,
            stashInitialSize: 786432,
            isLive: true,
            lazyLoad: false,
            liveBufferLatencyChasing: false,
            liveSync: false,
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 40,
            autoCleanupMinBackwardDuration: 20,
          },
        )

        mpegtsRef.current = player
        player.attachMediaElement(media)
        player.load()
        player.on('error', async () => {
          void trySource(sourceIndex + 1, 'Fluxo TS recusado no player otimizado.')
        })
        window.clearTimeout(fallbackTimer)
        successLocked = true
        const nextState = await attemptPlayback(media, 'Clique em play para iniciar')
        if (!cancelled) setPlayerState(nextState)
        return
      }

      if (media.canPlayType('application/vnd.apple.mpegurl') || media.canPlayType('video/mp2t')) {
        media.src = source.url
        window.clearTimeout(fallbackTimer)
        successLocked = true
        const nextState = await attemptPlayback(media, 'Clique em play para iniciar')
        if (!cancelled) setPlayerState(nextState)
        return
      }

      void trySource(sourceIndex + 1, 'Formato nativo indisponivel. Tentando outro caminho...')
    }

    void trySource(0)

    return () => {
      cancelled = true
      window.clearTimeout(fallbackTimer)
      media.removeEventListener('waiting', onWaiting)
      media.removeEventListener('playing', onPlaying)
      media.removeEventListener('stalled', onStalled)
      media.removeEventListener('loadedmetadata', onLoadedMetadata)
      media.removeEventListener('canplay', onCanPlay)
      media.removeEventListener('error', onError)
      cleanupPlayers()
    }
  }, [activeSurface, selectedPlaybackChannel?.id])

  useEffect(() => {
    let isActive = true

    const refresh = async () => {
      const nextStatus: Record<string, EmbedStatus> = {}
      const twitchChannels = embeds
        .filter((item) => item.platform === 'twitch')
        .map((item) => item.channel.trim().toLowerCase())
        .filter(Boolean)

      if (twitchChannels.length && settings.twitchClientId && settings.twitchAccessToken) {
        try {
          Object.assign(nextStatus, await fetchTwitchStatuses(twitchChannels, settings.twitchClientId, settings.twitchAccessToken))
        } catch (error) {
          const detail = error instanceof Error ? error.message : TWITCH_STATUS_HELP
          twitchChannels.forEach((channel) => {
            nextStatus[channel] = { label: 'Erro', state: 'error', detail, updatedAt: new Date().toISOString() }
          })
        }
      } else {
        twitchChannels.forEach((channel) => {
          nextStatus[channel] = { label: 'Sem auth', state: 'unknown', detail: TWITCH_STATUS_HELP, updatedAt: new Date().toISOString() }
        })
      }

      const kickChannels = embeds
        .filter((item) => item.platform === 'kick')
        .map((item) => item.channel.trim().toLowerCase())
        .filter(Boolean)

      if (kickChannels.length && settings.kickClientId && settings.kickClientSecret) {
        try {
          let accessToken = settings.kickAppAccessToken
          let expiresAt = settings.kickAppTokenExpiresAt

          if (!accessToken || !isTokenFresh(expiresAt)) {
            const token = await fetchKickAppAccessToken(
              settings.kickClientId,
              settings.kickClientSecret,
              DEFAULT_XTREAM_PROXY_URL,
            )
            accessToken = token.accessToken
            expiresAt = token.expiresAt

            if (isActive) {
              setSettings((current) => {
                const next = {
                  ...current,
                  kickAppAccessToken: accessToken,
                  kickAppTokenExpiresAt: expiresAt,
                }
                saveJson(SETTINGS_KEY, next)
                return next
              })
            }
          }

          Object.assign(
            nextStatus,
            await fetchKickStatuses(kickChannels, accessToken, DEFAULT_XTREAM_PROXY_URL),
          )
        } catch (error) {
          const detail = error instanceof Error ? error.message : KICK_STATUS_HELP
          kickChannels.forEach((channel) => {
            nextStatus[channel] = { label: 'Erro', state: 'error', detail, updatedAt: new Date().toISOString() }
          })
        }
      } else {
        try {
          Object.assign(
            nextStatus,
            await fetchKickStatusesFromWorker(kickChannels, DEFAULT_XTREAM_PROXY_URL),
          )
        } catch {
          kickChannels.forEach((channel) => {
            nextStatus[channel] = {
              label: 'Sem auth',
              state: 'unknown',
              detail: KICK_STATUS_HELP,
              updatedAt: new Date().toISOString(),
            }
          })
        }
      }

      await Promise.all(
        embeds
          .filter((item) => item.statusEndpoint?.trim())
          .map(async (item) => {
            try {
              nextStatus[item.channel.toLowerCase()] = await fetchCustomStatus(item.statusEndpoint!.trim())
            } catch (error) {
              nextStatus[item.channel.toLowerCase()] = {
                label: 'Erro',
                state: 'error',
                detail: error instanceof Error ? error.message : 'Falha ao consultar status externo.',
                updatedAt: new Date().toISOString(),
              }
            }
          }),
      )

      if (isActive) setStatusMap(nextStatus)
    }

    void refresh()
    const interval = window.setInterval(() => void refresh(), 300000)
    return () => {
      isActive = false
      window.clearInterval(interval)
    }
  }, [embeds, settings.twitchAccessToken, settings.twitchClientId])

  async function connectXtream(credentials = xtream, persist = true) {
    const controller = new AbortController()
    const nextCredentials = withDefaultProxy(credentials)

    try {
      setIsLoading(true)
      setLoadError('')
      setTransferMessage('')
      const nextPlaylist = await fetchXtreamPlaylist(nextCredentials, controller.signal)
      setPlaylist(nextPlaylist)
      setSelectedChannelId(nextPlaylist.channels[0]?.id ?? null)
      setActiveSurface('iptv')
      setXtream(nextCredentials)
      if (persist) saveJson<PersistedConnection>(CONNECTION_KEY, { kind: 'xtream', remember: settings.rememberConnection, xtream: nextCredentials, m3u })
    } catch (error) {
      setLoadError(formatXtreamError(error, nextCredentials.serverUrl))
    } finally {
      setIsLoading(false)
    }
  }

  async function connectM3U(credentials = m3u, persist = true) {
    const controller = new AbortController()

    try {
      setIsLoading(true)
      setLoadError('')
      setTransferMessage('')
      const nextPlaylist = await fetchM3UPlaylist(credentials, controller.signal)
      setPlaylist(nextPlaylist)
      setSelectedChannelId(nextPlaylist.channels[0]?.id ?? null)
      setActiveSurface('iptv')
      setM3U(credentials)
      if (persist) saveJson<PersistedConnection>(CONNECTION_KEY, { kind: 'm3u', remember: settings.rememberConnection, xtream, m3u: credentials })
    } catch (error) {
      setLoadError(formatM3UError(error, credentials.url))
    } finally {
      setIsLoading(false)
    }
  }

  function connectTwitch() {
    if (settings.twitchClientId.trim()) window.location.href = buildTwitchAuthUrl(settings.twitchClientId)
  }

  function setSurface(surface: MediaSurface) {
    setActiveSurface(surface)

    if (surface === 'twitch') {
      setSelectedEmbedId((current) => current && twitchEmbeds.some((item) => item.id === current) ? current : (twitchEmbeds[0]?.id ?? null))
      return
    }

    if (surface === 'kick') {
      setSelectedEmbedId((current) => current && kickEmbeds.some((item) => item.id === current) ? current : (kickEmbeds[0]?.id ?? null))
      return
    }
  }

  function activateIPTV(channelId?: string) {
    if (channelId) setSelectedChannelId(channelId)
    setSurface('iptv')
  }

  function activateEmbed(embed: EmbedStream) {
    setSelectedEmbedId(embed.id)
    setSurface(embed.platform)
    setPlayerError('')
    setPlayerState(embed.platform === 'twitch' ? 'Twitch em foco' : 'Kick em foco')
  }

  function addEmbed() {
    if (!embedDraft.channel.trim()) return
    const nextEmbed = {
      id: crypto.randomUUID(),
      platform: embedDraft.platform,
      channel: embedDraft.channel.trim(),
      title: embedDraft.title.trim() || `${embedDraft.platform} / ${embedDraft.channel.trim()}`,
      statusEndpoint: embedDraft.statusEndpoint?.trim() || undefined,
    }
    setEmbeds((current) => [
      nextEmbed,
      ...current,
    ])
    setSelectedEmbedId(nextEmbed.id)
    setActiveSurface(nextEmbed.platform)
    setEmbedDraft({ id: '', platform: 'twitch', channel: '', title: '', statusEndpoint: '' })
  }

  function toggleFavorite(channelId: string) {
    setFavorites((current) => (current.includes(channelId) ? current.filter((id) => id !== channelId) : [channelId, ...current]))
  }

  function removeEmbed(embedId: string) {
    setEmbeds((current) => current.filter((entry) => entry.id !== embedId))

    if (selectedEmbedId === embedId) {
      const nextTwitch = twitchEmbeds.find((entry) => entry.id !== embedId)
      const nextKick = kickEmbeds.find((entry) => entry.id !== embedId)

      if (activeSurface === 'twitch' && nextTwitch) {
        setSelectedEmbedId(nextTwitch.id)
      } else if (activeSurface === 'kick' && nextKick) {
        setSelectedEmbedId(nextKick.id)
      } else {
        setSelectedEmbedId(null)
        setActiveSurface('iptv')
      }
    }
  }

  function exportConnectionBundle() {
    const payload: ConnectionTransferBundle = {
      version: 1,
      sourceTab,
      xtream,
      m3u,
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = `iptv-pages-hub-${sourceTab}-backup.json`
    link.click()
    URL.revokeObjectURL(objectUrl)
    setLoadError('')
    setTransferMessage('Configuracao exportada. Leve esse arquivo para o PC do trabalho e importe la.')
  }

  async function importConnectionBundle(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    try {
      const rawText = await file.text()
      const payload = JSON.parse(rawText) as Partial<ConnectionTransferBundle>
      const nextSourceTab = payload.sourceTab === 'm3u' ? 'm3u' : 'xtream'
      const nextXtream = withDefaultProxy(payload.xtream ? payload.xtream as XtreamCredentials : defaultXtream)
      const nextM3U = mergeM3U(payload.m3u)

      setSourceTab(nextSourceTab)
      setXtream(nextXtream)
      setM3U(nextM3U)
      saveJson<PersistedFormState>(FORM_STATE_KEY, {
        sourceTab: nextSourceTab,
        xtream: nextXtream,
        m3u: nextM3U,
      })
      setLoadError('')
      setTransferMessage('Configuracao importada neste navegador. Agora e so conectar a playlist.')
    } catch {
      setTransferMessage('')
      setLoadError('Nao consegui importar esse arquivo. Use um backup gerado pelo botao Exportar.')
    } finally {
      input.value = ''
    }
  }

  return (
    <div class="app-shell">
        <header class="topbar">
          <div>
            <p class="eyebrow">IPTV Pages Hub</p>
            <h1>links e canais ao vivo num painel rapido e limpo</h1>
            <p class="hero-subcopy">Horario no Brasil, em Londres, em Chicago, em Paris, em LA e em NY no topo. A area do IPTV continua com o mesmo playback por baixo, so reorganizei a navegacao visual.</p>
            <div class="topbar-meta">
              {marketQuotes.length ? (
                <div class="market-strip" aria-label="Painel sutil de mercado">
                  {marketQuotes.map((item) => (
                    <div class={`market-pill ${item.trend}`} key={item.id}>
                      <span>{item.label}</span>
                      <strong>{item.value}</strong>
                      <small>{item.change}</small>
                    </div>
                  ))}
                </div>
              ) : null}
              <div class="topbar-stats">
                {dashboardTimes.map((entry) => (
                  <div class="stat-card time-card" key={entry.label}>
                    <span>{entry.label}</span>
                    <strong>{entry.value}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div class="surface-switch hero-surface-switch">
            <button class={activeSurface === 'iptv' ? 'active' : ''} type="button" onClick={() => setSurface('iptv')}>IPTV</button>
          <button class={activeSurface === 'twitch' ? 'active' : ''} disabled={!twitchEmbeds.length} type="button" onClick={() => setSurface('twitch')}>Twitch</button>
          <button class={activeSurface === 'kick' ? 'active' : ''} disabled={!kickEmbeds.length} type="button" onClick={() => setSurface('kick')}>Kick</button>
          <button class={activeSurface === 'news' ? 'active' : ''} type="button" onClick={() => setSurface('news')}>Noticias</button>
        </div>
      </header>

      <div class="news-shortcuts">
        {newsLinks.map((item) => (
          <button class={activeSurface === 'news' && selectedNewsLink.id === item.id ? 'feed-pill active button-pill' : 'feed-pill button-pill'} key={item.id} type="button" onClick={() => { setSelectedNewsId(item.id); setSurface('news') }}>
            <span>{item.name}</span>
            <strong>{item.streamUrl || item.embedUrl ? 'PLAY' : 'LINK'}</strong>
          </button>
        ))}
      </div>

      <main class="hub-grid">
        <aside class="panel sidebar-panel">
          <div class="sidebar-stack">
            <div class="sidebar-section active">
              <button class={showLiveNowPanel ? 'section-toggle active' : 'section-toggle'} type="button" onClick={() => setShowLiveNowPanel((current) => !current)}>
                <span>Ao vivo agora</span>
                <small>{liveEmbeds.length ? `${liveEmbeds.length} feeds live` : 'Nenhum feed live'}</small>
              </button>
              {showLiveNowPanel ? <div class="sidebar-content">
                <div class="sidebar-list">
                  {liveEmbeds.length ? liveEmbeds.map((item) => {
                    const status = statusMap[item.channel.toLowerCase()]
                    return (
                      <button
                        key={item.id}
                        class={activeEmbed?.id === item.id ? 'list-row active media-row' : 'list-row media-row'}
                        type="button"
                        onClick={() => activateEmbed(item)}
                      >
                        <div class="list-row-copy">
                          <strong>{item.title}</strong>
                          <span>{item.platform === 'twitch' ? 'Twitch' : 'Kick'} · {item.channel}</span>
                        </div>
                        <span class={statusTone(status?.state || 'online', item.platform)}>{status?.label || 'Ao vivo'}</span>
                      </button>
                    )
                  }) : <div class="empty-state compact-empty"><strong>Nenhum feed ao vivo agora.</strong><span>Twitch e Kick aparecem aqui automaticamente quando o status vier como online.</span></div>}
                </div>
              </div> : null}
            </div>

            <div class="sidebar-section">
              <button class={showConnectionPanel ? 'section-toggle active' : 'section-toggle'} type="button" onClick={() => setShowConnectionPanel((current) => !current)}>
                <span>Conexao e backup</span>
                <small>{playlist?.sourceLabel || 'Sem playlist'}</small>
              </button>
              {showConnectionPanel ? (
                <div class="sidebar-content stack">
                  <div class="source-switch">
                    <button class={sourceTab === 'xtream' ? 'active' : ''} type="button" onClick={() => setSourceTab('xtream')}>Xtream Codes</button>
                    <button class={sourceTab === 'm3u' ? 'active' : ''} type="button" onClick={() => setSourceTab('m3u')}>M3U URL</button>
                  </div>
                  {sourceTab === 'xtream' ? (
                    <form class="stack" onSubmit={(event) => { event.preventDefault(); void connectXtream() }}>
                      <label><span>Servidor</span><input placeholder="http://ou-https://painel.exemplo.com" value={xtream.serverUrl} onInput={(event) => setXtream((current) => ({ ...current, serverUrl: (event.currentTarget as HTMLInputElement).value }))} /></label>
                      <label><span>Proxy HTTPS</span><input placeholder="https://seu-proxy.exemplo.workers.dev" value={xtream.proxyUrl || ''} onInput={(event) => setXtream((current) => ({ ...current, proxyUrl: (event.currentTarget as HTMLInputElement).value }))} /></label>
                      {xtreamNeedsHttps ? <div class="alert warn compact-alert"><strong>Servidor em HTTP</strong><span>GitHub Pages roda em HTTPS. Sem proxy, o navegador bloqueia esse login.</span><div class="inline-actions"><button class="ghost-button compact" type="button" onClick={() => setXtream((current) => ({ ...current, serverUrl: xtreamHttpsSuggestion }))}>Trocar para {xtreamHttpsSuggestion}</button></div></div> : null}
                      <div class="field-grid"><label><span>Usuario</span><input value={xtream.username} onInput={(event) => setXtream((current) => ({ ...current, username: (event.currentTarget as HTMLInputElement).value }))} /></label><label><span>Senha</span><input type="password" value={xtream.password} onInput={(event) => setXtream((current) => ({ ...current, password: (event.currentTarget as HTMLInputElement).value }))} /></label></div>
                      <label><span>Saida para browser</span><select value={xtream.output} onChange={(event) => setXtream((current) => ({ ...current, output: (event.currentTarget as HTMLSelectElement).value as 'auto' | 'm3u8' | 'ts' }))}><option value="auto">auto (testa melhor caminho)</option><option value="m3u8">m3u8</option><option value="ts">ts</option></select></label>
                      <button class="primary-button" disabled={isLoading} type="submit">{isLoading ? 'Carregando playlist...' : 'Entrar com Xtream'}</button>
                    </form>
                  ) : (
                    <form class="stack" onSubmit={(event) => { event.preventDefault(); void connectM3U() }}>
                      <label><span>URL da playlist</span><input placeholder="https://exemplo.com/lista.m3u" value={m3u.url} onInput={(event) => setM3U({ url: (event.currentTarget as HTMLInputElement).value })} /></label>
                      <button class="primary-button" disabled={isLoading} type="submit">{isLoading ? 'Lendo playlist...' : 'Abrir M3U'}</button>
                    </form>
                  )}
                  <div class="subtle-card stack compact-card">
                    <label class="check-row"><input checked={settings.rememberConnection} type="checkbox" onChange={(event) => setSettings((current) => ({ ...current, rememberConnection: (event.currentTarget as HTMLInputElement).checked }))} /><span>Lembrar neste navegador</span></label>
                    <div class="button-row"><button class="ghost-button" type="button" onClick={exportConnectionBundle}>Exportar conexao</button><button class="ghost-button" type="button" onClick={() => fileInputRef.current?.click()}>Importar conexao</button><input ref={fileInputRef} accept=".json,application/json" class="hidden-input" type="file" onChange={importConnectionBundle} /></div>
                    {transferMessage ? <p class="helper-copy">{transferMessage}</p> : null}
                  </div>
                  {loadError ? <p class="alert error">{loadError}</p> : null}
                </div>
              ) : null}
            </div>

            <div class={activeSurface === 'iptv' ? 'sidebar-section active' : 'sidebar-section'}>
              <button class={showIptvPanel ? 'section-toggle active' : 'section-toggle'} type="button" onClick={() => setShowIptvPanel((current) => !current)}>
                <span>Lista IPTV</span>
                <small>{new Intl.NumberFormat('pt-BR').format(visibleChannels.length)} canais</small>
              </button>
              {showIptvPanel ? (
                <div class="sidebar-content stack">
                  <div class="field-grid compact sidebar-filters">
                    <label><span>Buscar</span><input placeholder="Nome, grupo ou EPG" value={searchTerm} onInput={(event) => setSearchTerm((event.currentTarget as HTMLInputElement).value)} /></label>
                    <label class="group-field"><span>Grupo</span><select class="group-select" value={groupFilter} onChange={(event) => setGroupFilter((event.currentTarget as HTMLSelectElement).value)}><option value="Todos">Todos</option>{(playlist?.groups ?? []).map((group) => <option key={group} value={group}>{group}</option>)}</select></label>
                  </div>
                  <div class="group-summary"><span class="pill active-group">{groupFilter}</span><span class="helper-copy">{playlist?.groups.length || 0} grupos</span></div>
                  <div class="sidebar-list">
                    {displayedChannels.length ? displayedChannels.map((channel) => (
                      <button key={channel.id} class={channel.id === selectedChannel?.id ? 'list-row active' : 'list-row'} type="button" onClick={() => activateIPTV(channel.id)}>
                        <div class="list-row-art">{channel.logo ? <img alt={channel.name} loading="lazy" src={channel.logo} /> : <span>{channel.name.slice(0, 2).toUpperCase()}</span>}</div>
                        <div class="list-row-copy"><strong>{channel.name}</strong><span>{channel.group}</span></div>
                        <span class={favorites.includes(channel.id) ? 'favorite-button active' : 'favorite-button'}>{favorites.includes(channel.id) ? 'Salvo' : 'Fav'}</span>
                      </button>
                    )) : <div class="empty-state compact-empty"><strong>Nenhum canal encontrado.</strong><span>Ajuste os filtros ou conecte uma playlist.</span></div>}
                  </div>
                  {hasMoreChannels ? <div class="load-more-row"><button class="ghost-button" type="button" onClick={() => setVisibleCount((current) => current + CHANNEL_BATCH_STEP)}>Adicionar mais {Math.min(CHANNEL_BATCH_STEP, visibleChannels.length - displayedChannels.length)}</button></div> : null}
                </div>
              ) : null}
            </div>

            <div class={activeSurface === 'twitch' ? 'sidebar-section active' : 'sidebar-section'}>
              <button class={showTwitchPanel ? 'section-toggle active' : 'section-toggle'} disabled={!twitchEmbeds.length} type="button" onClick={() => setShowTwitchPanel((current) => !current)}>
                <span>Feeds Twitch</span>
                <small>{onlineTwitchCount} ao vivo - {twitchEmbeds.length} total</small>
              </button>
              {showTwitchPanel ? <div class="sidebar-content"><div class="sidebar-list">{sortedTwitchEmbeds.length ? sortedTwitchEmbeds.map((item) => { const status = statusMap[item.channel.toLowerCase()]; return <button key={item.id} class={activeEmbed?.id === item.id ? 'list-row active media-row' : 'list-row media-row'} type="button" onClick={() => activateEmbed(item)}><div class="list-row-copy"><strong>{item.title}</strong><span>{item.channel}</span></div><span class={statusTone(status?.state || 'unknown', 'twitch')}>{status?.label || 'Aguardando'}</span></button> }) : <div class="empty-state compact-empty"><strong>Nenhum feed da Twitch cadastrado.</strong><span>Adicione um canal no painel da direita.</span></div>}</div></div> : null}
            </div>

            <div class={activeSurface === 'kick' ? 'sidebar-section active' : 'sidebar-section'}>
              <button class={showKickPanel ? 'section-toggle active' : 'section-toggle'} disabled={!kickEmbeds.length} type="button" onClick={() => setShowKickPanel((current) => !current)}>
                <span>Feeds Kick</span>
                <small>{`${onlineKickCount} ao vivo - ${kickEmbeds.length} total`}</small>
              </button>
              {showKickPanel ? <div class="sidebar-content"><div class="sidebar-list">{sortedKickEmbeds.length ? sortedKickEmbeds.map((item) => { const status = statusMap[item.channel.toLowerCase()]; return <button key={item.id} class={activeEmbed?.id === item.id ? 'list-row active media-row' : 'list-row media-row'} type="button" onClick={() => activateEmbed(item)}><div class="list-row-copy"><strong>{item.title}</strong><span>{item.channel}</span></div><span class={statusTone(status?.state || 'unknown', 'kick')}>{status?.label || 'Aguardando'}</span></button> }) : <div class="empty-state compact-empty"><strong>Nenhum feed da Kick cadastrado.</strong><span>Adicione um canal no painel da direita.</span></div>}</div></div> : null}
              {showKickPanel && !onlineKickCount && kickEmbeds.length ? <div class="sidebar-content"><p class="helper-copy">O worker do app atualiza o status da Kick em segundo plano. Se algum canal seguir sem selo, eu ja deixei o override manual disponivel no painel da direita.</p></div> : null}
            </div>

            <div class={activeSurface === 'news' ? 'sidebar-section active' : 'sidebar-section'}>
              <button class={showNewsPanel ? 'section-toggle active' : 'section-toggle'} type="button" onClick={() => setShowNewsPanel((current) => !current)}>
                <span>Noticias ao vivo</span>
                <small>{newsLinks.length} links</small>
              </button>
              {showNewsPanel ? <div class="sidebar-content"><div class="sidebar-list">{newsLinks.map((item) => <button key={item.id} class={selectedNewsLink.id === item.id ? 'list-row active media-row' : 'list-row media-row'} type="button" onClick={() => setSelectedNewsId(item.id)}><div class="list-row-copy"><strong>{item.name}</strong><span>{item.source}</span></div><span class="status-chip unknown">Link</span></button>)}</div></div> : null}
            </div>
          </div>
        </aside>

        <section class="panel stage-panel">
          {activeSurface === 'news' ? (
            <div class="feed-strip-shell stage-feed-strip">
              <button aria-label="Ver canais anteriores" class="feed-strip-nav" disabled={!newsStripLeftReady} type="button" onClick={() => scrollNewsStrip('left')}>
                <span aria-hidden="true">‹</span>
              </button>
              <div class="feed-strip feed-strip-scroll" ref={newsStripRef}>
                {newsLinks.map((item) => (
                  <button class={selectedNewsLink.id === item.id ? 'feed-pill active button-pill' : 'feed-pill button-pill'} key={item.id} type="button" onClick={() => setSelectedNewsId(item.id)}>
                    <span>{item.name}</span>
                    <strong>LIVE</strong>
                  </button>
                ))}
              </div>
              <button aria-label="Ver mais canais" class="feed-strip-nav" disabled={!newsStripRightReady} type="button" onClick={() => scrollNewsStrip('right')}>
                <span aria-hidden="true">›</span>
              </button>
            </div>
          ) : (
            <div class="feed-strip stage-feed-strip">
              {activeSurface === 'iptv' ? (
                <>
                  <span class="feed-pill active">{groupFilter}</span>
                  <span class="feed-pill">{favorites.length} favoritos</span>
                  <span class="feed-pill">{new Intl.NumberFormat('pt-BR').format(visibleChannels.length)} visiveis</span>
                  <span class="feed-pill soft">{playerState}</span>
                </>
              ) : (
                activeFeedItems.map((item) => {
                  const status = statusMap[item.channel.toLowerCase()]
                  return (
                    <button class={feedPillTone(item.platform, activeEmbed?.id === item.id)} key={item.id} type="button" onClick={() => activateEmbed(item)}>
                      <span>{item.channel}</span>
                      <strong>{status?.label || 'OFF'}</strong>
                    </button>
                  )
                })
              )}
            </div>
          )}

          {activeSurface === 'iptv' ? (
            <>
              <div class="panel-heading">
                <div><p class="section-tag">IPTV ao vivo</p><h2>{selectedChannel?.name || 'Selecione um canal'}</h2></div>
                <div class="pill-row">{selectedChannel ? <button class={favorites.includes(selectedChannel.id) ? 'favorite-pill active' : 'favorite-pill'} type="button" onClick={() => toggleFavorite(selectedChannel.id)}>{favorites.includes(selectedChannel.id) ? 'Favorito' : 'Favoritar'}</button> : null}<span class="pill">{selectedChannel?.group || 'Sem grupo'}</span></div>
              </div>
              <div class="player-frame"><video controls playsInline preload="auto" ref={videoRef} /></div>
              <div class="player-meta">
                <div class="subtle-card compact-card"><p class="section-tag">Status</p><h3>{playerState}</h3><p class="helper-copy">A sidebar fica focada em navegacao e o palco central abre um feed por vez.</p></div>
                <div class="subtle-card compact-card"><p class="section-tag">URL da stream</p><h3 class="small-text">{selectedChannel?.streamUrl || 'Aguardando selecao de canal'}</h3></div>
              </div>
              {playerError ? <p class="alert error">{playerError}</p> : null}
            </>
          ) : activeSurface === 'news' ? (
            <>
              <div class="panel-heading">
                <div><p class="section-tag">Noticias ao vivo</p><h2>{selectedNewsLink.name}</h2></div>
                <div class="pill-row"><span class="pill">{selectedNewsLink.source}</span><a class="ghost-button compact" href={selectedNewsLink.href} rel="noreferrer" target="_blank">Abrir transmissao</a></div>
              </div>
              {selectedNewsPlayback ? (
                <>
                  <div class="player-frame"><video controls playsInline preload="auto" ref={videoRef} /></div>
                  <div class="player-meta">
                    <div class="subtle-card compact-card"><p class="section-tag">Canal</p><h3>{selectedNewsLink.name}</h3><p class="helper-copy">{selectedNewsLink.note}</p></div>
                    <div class="subtle-card compact-card"><p class="section-tag">Status</p><h3>{playerState}</h3><p class="helper-copy">Feed de noticias rodando no mesmo player leve usado no site, via proxy HLS para abrir liso no browser.</p></div>
                  </div>
                  {playerError ? <p class="alert error">{playerError}</p> : null}
                </>
              ) : selectedNewsLink.embedUrl ? (
                <>
                  <div class="player-frame embed-stage-frame news-embed-frame"><iframe allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowFullScreen loading="lazy" src={selectedNewsLink.embedUrl} title={selectedNewsLink.name} /></div>
                  <div class="player-meta">
                    <div class="subtle-card compact-card"><p class="section-tag">Canal</p><h3>{selectedNewsLink.name}</h3><p class="helper-copy">{selectedNewsLink.note}</p></div>
                    <div class="subtle-card compact-card"><p class="section-tag">Origem</p><h3>{selectedNewsLink.source}</h3><p class="helper-copy">Se o embed for bloqueado pela emissora ou pela sua regiao, use o botao para abrir a transmissao original.</p></div>
                  </div>
                </>
              ) : (
                <div class="subtle-card compact-card news-stage-card">
                  <h3>{selectedNewsLink.name}</h3>
                  <p class="helper-copy">{selectedNewsLink.note}</p>
                  <p class="helper-copy">Esse canal abre em outra guia para manter o site leve quando nao existe embed confiavel dentro da pagina.</p>
                </div>
              )}
              <div class="feed-chip-grid news-link-grid">
                {newsLinks.map((item) => (
                  <article class="feed-chip-card" key={item.id}>
                    <div>
                      <p class="section-tag">{item.source}</p>
                      <h3>{item.name}</h3>
                      <p class="helper-copy">{item.note}</p>
                    </div>
                    <div class="feed-chip-actions">
                      <button class="ghost-button compact" type="button" onClick={() => setSelectedNewsId(item.id)}>Selecionar</button>
                      <a class="ghost-button compact" href={item.href} rel="noreferrer" target="_blank">Abrir link</a>
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : activeEmbed ? (
            <>
              <div class="panel-heading">
                <div><p class="section-tag">{activeSurface === 'twitch' ? 'Twitch' : 'Kick'}</p><h2>{activeEmbed.title}</h2></div>
                <div class="pill-row"><span class={statusTone(statusMap[activeEmbed.channel.toLowerCase()]?.state || 'unknown', activeSurface === 'kick' ? 'kick' : 'twitch')}>{statusMap[activeEmbed.channel.toLowerCase()]?.label || 'Aguardando'}</span><a class="ghost-button compact" href={activeSurface === 'twitch' ? `https://twitch.tv/${activeEmbed.channel}` : `https://kick.com/${activeEmbed.channel}`} rel="noreferrer" target="_blank">Abrir original</a></div>
              </div>
              <div class="player-frame embed-stage-frame"><iframe allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowFullScreen loading="lazy" src={activeSurface === 'twitch' ? buildTwitchEmbedUrl(activeEmbed.channel) : buildKickEmbedUrl(activeEmbed.channel)} title={activeEmbed.title} /></div>
              <div class="player-meta">
                <div class="subtle-card compact-card"><p class="section-tag">Canal</p><h3>{activeEmbed.channel}</h3><p class="helper-copy">{statusMap[activeEmbed.channel.toLowerCase()]?.detail || 'Feed ativo no palco principal.'}</p></div>
                <div class="subtle-card compact-card"><p class="section-tag">Audio</p><h3>{activeSurface === 'kick' ? 'Kick sem mute forcado' : 'Feed focado'}</h3><p class="helper-copy">{activeSurface === 'kick' ? 'Removi o muted=true do embed. Se o navegador ainda segurar audio, use Abrir original.' : 'Ao abrir Twitch, a secao Kick fica recolhida automaticamente.'}</p></div>
              </div>
            </>
          ) : <div class="empty-stage"><strong>Nenhum feed selecionado.</strong><span>Escolha um canal ou feed na sidebar.</span></div>}
        </section>

        <section class="panel manager-panel">
          <div class="panel-heading">
            <div><p class="section-tag">Gerenciar feeds</p><h2>Twitch e Kick</h2></div>
            <span class="pill">{embeds.length} feeds cadastrados</span>
          </div>
          <div class="embed-tools">
            <div class="subtle-card stack compact-card">
              <div class="field-grid compact">
                <label><span>Twitch Client ID</span><input placeholder="Para status oficial da Twitch" value={settings.twitchClientId} onInput={(event) => setSettings((current) => ({ ...current, twitchClientId: (event.currentTarget as HTMLInputElement).value }))} /></label>
                <label><span>Twitch token</span><input placeholder="Preenchido via OAuth" value={settings.twitchAccessToken} onInput={(event) => setSettings((current) => ({ ...current, twitchAccessToken: (event.currentTarget as HTMLInputElement).value }))} /></label>
              </div>
              <div class="field-grid compact">
                <label><span>Kick Client ID</span><input placeholder="App da Kick para status oficial" value={settings.kickClientId} onInput={(event) => setSettings((current) => ({ ...current, kickClientId: (event.currentTarget as HTMLInputElement).value, kickAppAccessToken: '', kickAppTokenExpiresAt: '' }))} /></label>
                <label><span>Kick secret</span><input placeholder="Fica local neste navegador" type="password" value={settings.kickClientSecret} onInput={(event) => setSettings((current) => ({ ...current, kickClientSecret: (event.currentTarget as HTMLInputElement).value, kickAppAccessToken: '', kickAppTokenExpiresAt: '' }))} /></label>
              </div>
              <div class="button-row"><button class="ghost-button" type="button" onClick={connectTwitch}>Conectar Twitch OAuth</button></div>
              <p class="helper-copy">Twitch usa OAuth do navegador. Na Kick, o site ja consulta o status oficial pelo worker do app; esses campos ficam como override manual caso voce queira testar outra credencial.</p>
            </div>
            <div class="subtle-card stack compact-card">
              <div class="field-grid compact">
                <label><span>Plataforma</span><select value={embedDraft.platform} onChange={(event) => setEmbedDraft((current) => ({ ...current, platform: (event.currentTarget as HTMLSelectElement).value as 'twitch' | 'kick' }))}><option value="twitch">Twitch</option><option value="kick">Kick</option></select></label>
                <label><span>Canal</span><input placeholder="nome-do-canal" value={embedDraft.channel} onInput={(event) => setEmbedDraft((current) => ({ ...current, channel: (event.currentTarget as HTMLInputElement).value }))} /></label>
              </div>
              <label><span>Titulo</span><input placeholder="Ex.: Stream secundaria" value={embedDraft.title} onInput={(event) => setEmbedDraft((current) => ({ ...current, title: (event.currentTarget as HTMLInputElement).value }))} /></label>
              <label><span>Endpoint de status opcional</span><input placeholder="https://seu-endpoint/status.json" value={embedDraft.statusEndpoint} onInput={(event) => setEmbedDraft((current) => ({ ...current, statusEndpoint: (event.currentTarget as HTMLInputElement).value }))} /></label>
              <button class="primary-button" type="button" onClick={addEmbed}>Adicionar feed</button>
            </div>
          </div>
          <div class="feed-chip-grid">
            {embeds.map((item) => {
              const status = statusMap[item.channel.toLowerCase()]
              return <article class="feed-chip-card" key={item.id}><div><p class="section-tag">{item.platform}</p><h3>{item.title}</h3><p class="helper-copy">{item.channel}</p></div><div class="feed-chip-actions"><span class={statusTone(status?.state || 'unknown', item.platform)}>{status?.label || 'Aguardando'}</span><button class="ghost-button compact" type="button" onClick={() => activateEmbed(item)}>Abrir</button><button class="ghost-button compact" type="button" onClick={() => removeEmbed(item.id)}>Remover</button></div></article>
            })}
          </div>
        </section>
      </main>
    </div>
  )
}
