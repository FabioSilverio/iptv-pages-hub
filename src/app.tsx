import type Hls from 'hls.js'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  buildProxyUrl,
  fetchM3UPlaylist,
  fetchXtreamPlaylist,
  type Channel,
  type PlaylistSession,
  type XtreamCredentials,
} from './lib/iptv'
import { radioStations as baseRadioStations, type RadioStation } from './lib/radios'

type AppView = 'live' | 'iptv' | 'radios' | 'links'
type IptvSource = 'm3u' | 'xtream'
type PlayerState = 'idle' | 'loading' | 'ready' | 'playing' | 'error'

interface DashPlayer {
  attach: (element: HTMLMediaElement) => Promise<void>
  configure?: (config: Record<string, unknown>) => void
  load: (url: string) => Promise<void>
  destroy: () => Promise<void>
  seekRange: () => { start: number; end: number }
  goToLive?: () => void
}

interface VerifiedFeed {
  id: string
  name: string
  group: string
  region: string
  quality: string
  source: string
  href: string
  streamUrl: string
  note: string
}

interface ExternalFeedLink {
  id: string
  name: string
  group: string
  href: string
  reason: string
}

interface PlayerItem {
  id: string
  name: string
  group: string
  region: string
  quality: string
  source: string
  href: string
  streamUrl: string
  fallbackStreamUrl?: string
  note: string
  mode?: 'tv' | 'radio'
  rewindHours?: number
}

type FavoriteChannel = Channel & { savedAt: string }

const M3U_URL_KEY = 'iptv-pages-lite.m3u-url'
const XTREAM_KEY = 'iptv-pages-lite.xtream'
const IPTV_SOURCE_KEY = 'iptv-pages-lite.iptv-source'
const LAST_NATIVE_KEY = 'iptv-pages-lite.last-native'
const LAST_RADIO_KEY = 'iptv-pages-lite.last-radio'
const LAST_VIEW_KEY = 'iptv-pages-lite.view'
const FAVORITE_CHANNELS_KEY = 'iptv-pages-lite.favorite-channels'
const DEFAULT_XTREAM_PROXY_URL = 'https://iptv-pages-hub-proxy.fabiogsilverio.workers.dev'
const COPE_REWIND_LIMIT_MS = 5 * 60 * 60 * 1000
const DASH_REWIND_SEGMENT_LIMIT = 4000
const RADIO_REWIND_OPTIONS = [15, 60, 120, 300]

const defaultXtream: XtreamCredentials = {
  serverUrl: '',
  username: '',
  password: '',
  output: 'auto',
  proxyUrl: DEFAULT_XTREAM_PROXY_URL,
}

const verifiedFeeds: VerifiedFeed[] = [
  {
    id: 'bbc-news',
    name: 'BBC News',
    group: 'Noticias',
    region: 'Reino Unido',
    quality: 'HD',
    source: 'BBC / Akamai',
    href: 'https://www.bbc.com/news/live',
    streamUrl: 'https://vs-hls-push-ww-live.akamaized.net/x=4/i=urn:bbc:pips:service:bbc_news_channel_hd/t=3840/v=pv14/b=5070016/main.m3u8',
    note: 'HLS publico testado com CORS aberto.',
  },
  {
    id: 'cbs-news-247',
    name: 'CBS News 24/7',
    group: 'Noticias',
    region: 'Estados Unidos',
    quality: 'HD',
    source: 'CBS',
    href: 'https://www.cbsnews.com/video/live-cbsnews/',
    streamUrl: 'https://news20e7hhcb.airspace-cdn.cbsivideo.com/index.m3u8',
    note: 'Feed HLS oficial com resposta 200.',
  },
  {
    id: 'france-24-english',
    name: 'France 24 English',
    group: 'Noticias',
    region: 'Franca',
    quality: 'HD',
    source: 'France 24',
    href: 'https://www.france24.com/en/live',
    streamUrl: 'https://static.france24.com/live/F24_EN_HI_HLS/live_web.m3u8',
    note: 'HLS direto, leve e estavel.',
  },
  {
    id: 'dw-news-english',
    name: 'DW News English',
    group: 'Noticias',
    region: 'Alemanha',
    quality: 'HD',
    source: 'DW',
    href: 'https://www.dw.com/en/live-tv/channel-english',
    streamUrl: 'https://dwamdstream102.akamaized.net/hls/live/2015525/dwstream102/master.m3u8',
    note: 'Feed HLS oficial da DW.',
  },
  {
    id: 'trt-world',
    name: 'TRT World',
    group: 'Noticias',
    region: 'Turquia',
    quality: 'HD',
    source: 'TRT',
    href: 'https://www.trtworld.com/live',
    streamUrl: 'https://tv-trtworld.medya.trt.com.tr/master.m3u8',
    note: 'HLS oficial com CORS liberado.',
  },
  {
    id: 'cgtn-news',
    name: 'CGTN News',
    group: 'Noticias',
    region: 'China',
    quality: 'HD',
    source: 'CGTN',
    href: 'https://www.cgtn.com/tv',
    streamUrl: 'https://english-livebkali.cgtn.com/live/encgtn.m3u8',
    note: 'Feed HLS direto.',
  },
  {
    id: 'bloomberg-us',
    name: 'Bloomberg US',
    group: 'Negocios',
    region: 'Estados Unidos',
    quality: 'HD',
    source: 'Bloomberg',
    href: 'https://www.bloomberg.com/live',
    streamUrl: 'https://www.bloomberg.com/media-manifest/streams/phoenix-us.m3u8',
    note: 'Manifest HLS publico testado.',
  },
  {
    id: 'newsmax',
    name: 'Newsmax',
    group: 'Noticias',
    region: 'Estados Unidos',
    quality: 'HD',
    source: 'Newsmax',
    href: 'https://www.newsmax.com/',
    streamUrl: 'https://nmx1ota.akamaized.net/hls/live/2107010/Live_1/index.m3u8',
    note: 'HLS publico com resposta 200.',
  },
  {
    id: 'rt-news',
    name: 'RT News English',
    group: 'Noticias',
    region: 'Internacional',
    quality: 'HD',
    source: 'RT',
    href: 'https://www.rt.com/on-air/rt-player/',
    streamUrl: 'https://rt-glb.rttv.com/live/rtnews/playlist.m3u8',
    note: 'Feed HLS direto. Pode variar por politica regional.',
  },
  {
    id: 'press-tv',
    name: 'Press TV',
    group: 'Noticias',
    region: 'Internacional',
    quality: 'HD',
    source: 'Press TV',
    href: 'https://www.presstv.ir/live',
    streamUrl: 'https://live.presstv.ir/hls/presstv.m3u8',
    note: 'HLS direto com CORS aberto.',
  },
  {
    id: 'tyc-sports-fan',
    name: 'TyC Sports Fan',
    group: 'Esportes',
    region: 'Argentina',
    quality: '1080p',
    source: 'TyC Sports Fan / Amagi',
    href: 'https://amg26268-amg26268c14-freelivesports-emea-10267.playouts.now.amagi.tv/ts-us-e2-n2/playlist/amg26268-sportsstudio-tycsports-freelivesportsemea/playlist.m3u8',
    streamUrl: 'https://amg26268-amg26268c14-freelivesports-emea-10267.playouts.now.amagi.tv/ts-us-e2-n2/playlist/amg26268-sportsstudio-tycsports-freelivesportsemea/playlist.m3u8',
    note: 'Substitui o TyC geo-blocked que retornava 403 fora da Argentina.',
  },
]

const externalLinks: ExternalFeedLink[] = [
  {
    id: 'espn-ar',
    name: 'ESPN Argentina',
    group: 'Esportes',
    href: 'https://www.espn.com.ar/where-to-watch/',
    reason: 'Sem HLS publico confiavel; link oficial mantido fora do player.',
  },
  {
    id: 'espn-2-ar',
    name: 'ESPN 2 Argentina',
    group: 'Esportes',
    href: 'https://www.espn.com.ar/where-to-watch/',
    reason: 'O host IPTV informado anteriormente nao resolve DNS.',
  },
  {
    id: 'espn-3-ar',
    name: 'ESPN 3 Argentina',
    group: 'Esportes',
    href: 'https://www.espn.com.ar/where-to-watch/',
    reason: 'Atalho oficial para nao quebrar o player.',
  },
  {
    id: 'espn-extra-ar',
    name: 'ESPN Extra Argentina',
    group: 'Esportes',
    href: 'https://www.espn.com.ar/where-to-watch/',
    reason: 'Mantido como link externo ate existir feed nativo testado.',
  },
  {
    id: 'tnt-sports-ar',
    name: 'TNT Sports Argentina',
    group: 'Esportes',
    href: 'https://tntsports.com.ar/',
    reason: 'Sem stream HLS estavel no navegador; link oficial preservado.',
  },
  {
    id: 'euronews',
    name: 'Euronews',
    group: 'Noticias',
    href: 'https://www.euronews.com/live',
    reason: 'Origem oficial disponivel como pagina externa.',
  },
  {
    id: 'abc-news-live',
    name: 'ABC News Live',
    group: 'Noticias',
    href: 'https://abcnews.go.com/Live',
    reason: 'Mantido como link oficial sem tentar iframe pesado.',
  },
  {
    id: 'nasa-live',
    name: 'NASA Live',
    group: 'Ciencia',
    href: 'https://www.nasa.gov/live/',
    reason: 'Pagina oficial, melhor aberta fora do player nativo.',
  },
]

const extraRadioStations: RadioStation[] = [
  {
    id: 'talksport-uk',
    name: 'talkSPORT',
    source: 'talkSPORT',
    category: 'UK Sport',
    logo: '',
    href: 'https://talksport.com/',
    streamUrl: 'https://radio.talksport.com/stream',
    note: 'Feed MP3 publico da talkSPORT. Mantido leve no player nativo.',
  },
  {
    id: 'tmc-sp',
    name: 'Radio TMC Sao Paulo',
    source: 'TMC / StreamTheWorld',
    category: 'Brasil Esportes',
    logo: 'https://img.radios.com.br/radio/lg/radio8803_1760319906.png',
    href: 'https://tmc360.com.br/',
    streamUrl: 'https://playerservices.streamtheworld.com/api/livestream-redirect/RT_SP.mp3',
    note: 'TMC Sao Paulo 100.1 FM, antiga Transamerica, em MP3 oficial via StreamTheWorld.',
  },
  {
    id: 'energia-97-sp',
    name: 'Energia 97 FM',
    source: 'Energia 97',
    category: 'Brasil Musica',
    logo: '',
    href: 'https://www.97fm.com.br/',
    streamUrl: 'https://streaming.inweb.com.br/energia',
    note: 'Energia 97 FM Sao Paulo, feed AAC/HTTPs testado via RadioBrowser.',
  },
  {
    id: 'cope-es',
    name: 'COPE Espanha',
    source: 'COPE / Flumotion',
    category: 'Espanha Noticias',
    logo: 'https://www.cope.es/favicon/cope/apple-touch-icon-192x192.png',
    href: 'https://www.cope.es/directos/malaga',
    streamUrl: 'https://flucast-bl03.flumotion.com/cope/net1.mp3',
    note: 'Feed MP3 da COPE Espanha. O buffer local permite voltar ate 5 horas depois que a aba fica aberta.',
    rewindHours: 5,
  },
]

const radioStations: RadioStation[] = [...baseRadioStations, ...extraRadioStations]

const viewLabels: Record<AppView, string> = {
  live: 'Ao vivo',
  iptv: 'IPTV',
  radios: 'Radios',
  links: 'Links',
}

function readStoredValue(key: string) {
  if (typeof window === 'undefined') return ''

  return window.localStorage.getItem(key) || ''
}

function readStoredJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback

  try {
    const rawValue = window.localStorage.getItem(key)
    return rawValue ? { ...fallback, ...JSON.parse(rawValue) } : fallback
  } catch {
    return fallback
  }
}

function readStoredArray<T>(key: string): T[] {
  if (typeof window === 'undefined') return []

  try {
    const rawValue = window.localStorage.getItem(key)
    if (!rawValue) return []

    const parsed = JSON.parse(rawValue)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function viewFromHash(hash: string): AppView | null {
  const value = hash.replace('#', '')
  return value === 'iptv' || value === 'links' || value === 'live' || value === 'radios' ? value : null
}

function readInitialView(): AppView {
  if (typeof window === 'undefined') return 'live'

  const hashView = viewFromHash(window.location.hash)
  if (hashView) return hashView

  const stored = readStoredValue(LAST_VIEW_KEY)
  return stored === 'iptv' || stored === 'links' || stored === 'live' || stored === 'radios' ? stored : 'live'
}

function compactUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    return `${url.host}${url.pathname.length > 34 ? `${url.pathname.slice(0, 34)}...` : url.pathname}`
  } catch {
    return rawUrl
  }
}

function formatRewindLabel(minutes: number) {
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`
}

function getMediaSeekRange(media: HTMLMediaElement, dashPlayer?: DashPlayer | null) {
  if (media.seekable.length) {
    return {
      start: media.seekable.start(0),
      end: media.seekable.end(media.seekable.length - 1),
    }
  }

  return dashPlayer?.seekRange()
}

function getProxyTargetUrl(requestUrl: string) {
  try {
    return new URL(requestUrl).searchParams.get('url')
  } catch {
    return null
  }
}

function getProxyBaseFromRequest(requestUrl: string) {
  try {
    const url = new URL(requestUrl)
    return `${url.origin}${url.pathname.replace(/\/proxy$/, '')}`
  } catch {
    return ''
  }
}

function shouldRewritePlaylistUrl(rawUrl: string) {
  return !/^(blob:|data:|skd:|urn:)/i.test(rawUrl)
}

function rewriteHlsManifestUrls(manifestText: string, requestUrl: string) {
  const targetUrl = getProxyTargetUrl(requestUrl)
  const proxyBase = getProxyBaseFromRequest(requestUrl)
  if (!targetUrl || !proxyBase) return manifestText

  const absolutizeAndProxy = (rawUrl: string) => {
    if (!rawUrl || !shouldRewritePlaylistUrl(rawUrl)) return rawUrl

    try {
      return buildProxyUrl(proxyBase, new URL(rawUrl, targetUrl).href)
    } catch {
      return rawUrl
    }
  }

  return manifestText
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed) return line

      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${absolutizeAndProxy(uri)}"`)
      }

      return absolutizeAndProxy(trimmed)
    })
    .join('\n')
}

function channelToPlayerItem(channel: Channel): PlayerItem {
  return {
    id: channel.id,
    name: channel.name,
    group: channel.group || 'Playlist',
    region: 'Playlist M3U',
    quality: channel.streamUrl.toLowerCase().includes('.m3u8') ? 'HLS' : 'Auto',
    source: channel.tvgId || channel.group || 'M3U',
    href: channel.streamUrl,
    streamUrl: channel.streamUrl,
    fallbackStreamUrl: channel.fallbackStreamUrl,
    note: channel.logo ? 'Canal carregado da playlist importada.' : 'Canal da playlist importada.',
  }
}

function radioToPlayerItem(station: RadioStation): PlayerItem {
  return {
    id: station.id,
    name: station.name,
    group: station.category,
    region: station.source,
    quality: station.streamUrl.toLowerCase().includes('.mpd') ? 'DASH' : 'Audio',
    source: station.source,
    href: station.href,
    streamUrl: station.streamUrl,
    note: station.note,
    mode: 'radio',
    rewindHours: station.rewindHours,
  }
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

function Icon({ name }: { name: 'play' | 'reload' | 'external' | 'search' | 'list' | 'link' | 'star' }) {
  const paths = {
    play: <path d="M8 5v14l11-7z" />,
    reload: <path d="M20 6v5h-5M4 18v-5h5M18.7 9A7 7 0 0 0 6.2 6.7L4 9m2 6a7 7 0 0 0 11.8 2.3L20 15" />,
    external: <path d="M14 4h6v6M13 11l7-7M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />,
    search: <path d="m21 21-4.3-4.3M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4z" />,
    list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
    link: <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" />,
    star: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6-5.4-2.9-5.4 2.9 1-6-4.4-4.3 6.1-.9z" />,
  }

  return (
    <svg aria-hidden="true" class="icon" viewBox="0 0 24 24">
      {paths[name]}
    </svg>
  )
}

export function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  const shakaRef = useRef<DashPlayer | null>(null)
  const mpegtsRef = useRef<{ destroy: () => void } | null>(null)
  const copeBufferAbortRef = useRef<AbortController | null>(null)
  const copeBufferChunksRef = useRef<Array<{ at: number; chunk: Uint8Array }>>([])
  const replayUrlRef = useRef('')

  const [view, setView] = useState<AppView>(() => readInitialView())
  const [selectedNativeId, setSelectedNativeId] = useState(() => readStoredValue(LAST_NATIVE_KEY) || verifiedFeeds[0].id)
  const [selectedRadioId, setSelectedRadioId] = useState(() => readStoredValue(LAST_RADIO_KEY) || radioStations[0].id)
  const [playerState, setPlayerState] = useState<PlayerState>('idle')
  const [playerError, setPlayerError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [isMuted, setIsMuted] = useState(true)
  const [query, setQuery] = useState('')
  const [iptvSource, setIptvSource] = useState<IptvSource>(() => readStoredValue(IPTV_SOURCE_KEY) === 'xtream' ? 'xtream' : 'm3u')
  const [m3uUrl, setM3uUrl] = useState(() => readStoredValue(M3U_URL_KEY))
  const [xtream, setXtream] = useState<XtreamCredentials>(() => readStoredJson<XtreamCredentials>(XTREAM_KEY, defaultXtream))
  const [playlist, setPlaylist] = useState<PlaylistSession | null>(null)
  const [playlistState, setPlaylistState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [playlistError, setPlaylistError] = useState('')
  const [selectedGroup, setSelectedGroup] = useState('Todos')
  const [selectedChannelId, setSelectedChannelId] = useState('')
  const [favoriteChannels, setFavoriteChannels] = useState<FavoriteChannel[]>(() => readStoredArray<FavoriteChannel>(FAVORITE_CHANNELS_KEY))
  const [showFavorites, setShowFavorites] = useState(false)
  const [radioReplayItem, setRadioReplayItem] = useState<PlayerItem | null>(null)
  const [copeBufferState, setCopeBufferState] = useState<'idle' | 'recording' | 'blocked'>('idle')
  const [copeBufferSeconds, setCopeBufferSeconds] = useState(0)

  const selectedNative = useMemo(
    () => verifiedFeeds.find((feed) => feed.id === selectedNativeId) || verifiedFeeds[0],
    [selectedNativeId],
  )

  const selectedRadio = useMemo(
    () => radioStations.find((station) => station.id === selectedRadioId) || radioStations[0],
    [selectedRadioId],
  )

  const filteredNativeFeeds = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized || view !== 'live') return verifiedFeeds

    return verifiedFeeds.filter((feed) =>
      `${feed.name} ${feed.group} ${feed.region} ${feed.source}`.toLowerCase().includes(normalized),
    )
  }, [query, view])

  const filteredRadioStations = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized || view !== 'radios') return radioStations

    return radioStations.filter((station) =>
      `${station.name} ${station.category} ${station.source}`.toLowerCase().includes(normalized),
    )
  }, [query, view])

  const playlistGroups = useMemo(() => ['Todos', ...(playlist?.groups || [])], [playlist])

  const filteredChannels = useMemo(() => {
    const channels = playlist?.channels || []
    const normalized = query.trim().toLowerCase()

    return channels
      .filter((channel) => selectedGroup === 'Todos' || channel.group === selectedGroup)
      .filter((channel) =>
        normalized
          ? `${channel.name} ${channel.group} ${channel.tvgId || ''}`.toLowerCase().includes(normalized)
          : true,
      )
      .slice(0, 400)
  }, [playlist, query, selectedGroup])

  const filteredFavoriteChannels = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const channels = normalized
      ? favoriteChannels.filter((channel) =>
        `${channel.name} ${channel.group} ${channel.tvgId || ''}`.toLowerCase().includes(normalized),
      )
      : favoriteChannels

    return channels.slice(0, 400)
  }, [favoriteChannels, query])

  const displayedChannels = showFavorites ? filteredFavoriteChannels : filteredChannels

  const selectedChannel = useMemo(
    () =>
      playlist?.channels.find((channel) => channel.id === selectedChannelId)
      || favoriteChannels.find((channel) => channel.id === selectedChannelId)
      || displayedChannels[0]
      || null,
    [displayedChannels, favoriteChannels, playlist, selectedChannelId],
  )

  const activeItem: PlayerItem = view === 'iptv' && selectedChannel
    ? channelToPlayerItem(selectedChannel)
    : view === 'radios'
      ? radioReplayItem || radioToPlayerItem(selectedRadio)
      : selectedNative

  const radioRewindMinutes = useMemo(() => {
    const maxMinutes = (selectedRadio.rewindHours || 0) * 60
    return RADIO_REWIND_OPTIONS.filter((minutes) => minutes <= maxMinutes)
  }, [selectedRadio.rewindHours])

  const groupedLinks = useMemo(() => {
    return externalLinks.reduce<Record<string, ExternalFeedLink[]>>((groups, link) => {
      groups[link.group] = groups[link.group] || []
      groups[link.group].push(link)
      return groups
    }, {})
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    window.history.scrollRestoration = 'manual'
    window.scrollTo({ left: 0, top: 0 })
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const syncViewFromHash = () => {
      const hashView = viewFromHash(window.location.hash)
      if (hashView) setView(hashView)
    }

    window.addEventListener('hashchange', syncViewFromHash)
    return () => window.removeEventListener('hashchange', syncViewFromHash)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    window.localStorage.setItem(LAST_VIEW_KEY, view)
    if (window.location.hash !== `#${view}`) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${view}`)
    }
  }, [view])

  useEffect(() => {
    setQuery('')
    if (typeof window !== 'undefined') window.scrollTo({ left: 0, top: 0 })
  }, [view])

  useEffect(() => {
    if (typeof window === 'undefined') return

    window.localStorage.setItem(LAST_NATIVE_KEY, selectedNativeId)
  }, [selectedNativeId])

  useEffect(() => {
    if (typeof window === 'undefined') return

    window.localStorage.setItem(LAST_RADIO_KEY, selectedRadioId)
  }, [selectedRadioId])

  useEffect(() => {
    if (typeof window === 'undefined') return

    window.localStorage.setItem(IPTV_SOURCE_KEY, iptvSource)
  }, [iptvSource])

  useEffect(() => {
    if (typeof window === 'undefined') return

    window.localStorage.setItem(M3U_URL_KEY, m3uUrl)
  }, [m3uUrl])

  useEffect(() => {
    if (typeof window === 'undefined') return

    window.localStorage.setItem(XTREAM_KEY, JSON.stringify(xtream))
  }, [xtream])

  useEffect(() => {
    if (typeof window === 'undefined') return

    window.localStorage.setItem(FAVORITE_CHANNELS_KEY, JSON.stringify(favoriteChannels))
  }, [favoriteChannels])

  useEffect(() => {
    const video = videoRef.current
    const streamUrl = activeItem?.streamUrl
    let cancelled = false

    if (!video || !streamUrl) return
    const media = video

    const destroyHls = () => {
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
    const destroyMpegts = () => {
      if (mpegtsRef.current) {
        mpegtsRef.current.destroy()
        mpegtsRef.current = null
      }
    }
    const destroyShaka = async () => {
      const dashPlayer = shakaRef.current
      if (dashPlayer) {
        shakaRef.current = null
        await dashPlayer.destroy().catch(() => undefined)
      }
    }

    const markReady = () => {
      if (!cancelled) setPlayerState('ready')
    }
    const markPlaying = () => {
      if (!cancelled) {
        setPlayerState('playing')
        setPlayerError('')
      }
    }
    const markWaiting = () => {
      if (!cancelled) setPlayerState('loading')
    }
    const markVideoError = () => {
      if (!cancelled) {
        setPlayerState('error')
        setPlayerError(media.error?.message || 'O navegador recusou essa stream.')
      }
    }

    const playWhenPossible = async () => {
      try {
        media.autoplay = true
        media.muted = isMuted
        await media.play()
      } catch {
        if (!cancelled) setPlayerState('ready')
      }
    }

    async function loadStream() {
      destroyHls()
      destroyMpegts()
      await destroyShaka()
      setPlayerState('loading')
      setPlayerError('')
      media.pause()
      media.removeAttribute('src')
      media.load()

      media.addEventListener('canplay', markReady)
      media.addEventListener('playing', markPlaying)
      media.addEventListener('waiting', markWaiting)
      media.addEventListener('error', markVideoError)

      const isHls = /\.m3u8?($|\?)/i.test(streamUrl)
      const isDash = /\.mpd($|\?)/i.test(streamUrl)
      const isTransportStream = /\.(ts|flv)($|\?)/i.test(streamUrl)

      if (!isHls) {
        if (isDash) {
          const imported = await import('shaka-player')
          if (cancelled) return

          const shakaModule = (imported as unknown as { default?: Record<string, unknown> })?.default ?? imported
          const shakaApi = shakaModule as {
            polyfill?: { installAll?: () => void }
            Player?: new () => DashPlayer
          }

          shakaApi.polyfill?.installAll?.()
          if (!shakaApi.Player) {
            setPlayerState('error')
            setPlayerError('Player DASH indisponivel neste navegador.')
            return
          }

          const dashPlayer = new shakaApi.Player()
          dashPlayer.configure?.({
            manifest: {
              dash: {
                initialSegmentLimit: DASH_REWIND_SEGMENT_LIMIT,
              },
            },
          })
          shakaRef.current = dashPlayer
          await dashPlayer.attach(media)
          if (cancelled) {
            await dashPlayer.destroy().catch(() => undefined)
            return
          }

          await dashPlayer.load(streamUrl)
          if (cancelled) {
            await dashPlayer.destroy().catch(() => undefined)
            return
          }

          const seekRange = getMediaSeekRange(media, dashPlayer)
          if (seekRange) {
            media.currentTime = seekRange.end
          } else {
            dashPlayer.goToLive?.()
          }

          await playWhenPossible()
          return
        }

        if (isTransportStream) {
          const { default: mpegts } = await import('mpegts.js')
          if (cancelled) return

          const player = mpegts.createPlayer({
            type: streamUrl.toLowerCase().includes('.flv') ? 'flv' : 'mpegts',
            isLive: true,
            url: streamUrl,
          })
          mpegtsRef.current = player
          player.attachMediaElement(media)
          player.load()
          await playWhenPossible()
          return
        }

        media.src = streamUrl
        media.load()
        await playWhenPossible()
        return
      }

      const { default: HlsClient } = await import('hls.js')
      if (!HlsClient.isSupported()) {
        if (media.canPlayType('application/vnd.apple.mpegurl')) {
          media.src = streamUrl
          media.load()
          await playWhenPossible()
          return
        }

        setPlayerState('error')
        setPlayerError('Este navegador nao oferece suporte HLS neste modo.')
        return
      }

      const BasePlaylistLoader = HlsClient.DefaultConfig.loader
      const ProxiedPlaylistLoader = class extends BasePlaylistLoader {
        load(context: unknown, config: unknown, callbacks: unknown) {
          const loaderContext = context as { url?: string }
          const loaderCallbacks = callbacks as {
            onSuccess?: (response: { data?: unknown }, stats: unknown, context: unknown, networkDetails: unknown) => void
          }
          const wrappedCallbacks = {
            ...(loaderCallbacks as Record<string, unknown>),
            onSuccess: (
              response: { data?: unknown },
              stats: unknown,
              successContext: unknown,
              networkDetails: unknown,
            ) => {
              if (typeof response.data === 'string' && loaderContext.url) {
                response.data = rewriteHlsManifestUrls(response.data, loaderContext.url)
              }
              loaderCallbacks.onSuccess?.(response, stats, successContext, networkDetails)
            },
          }

          super.load(context as never, config as never, wrappedCallbacks as never)
        }
      }

      const hls = new HlsClient({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 60,
        liveSyncDurationCount: 3,
        pLoader: ProxiedPlaylistLoader as never,
      })

      hlsRef.current = hls
      hls.attachMedia(media)
      hls.on(HlsClient.Events.MEDIA_ATTACHED, () => hls.loadSource(streamUrl))
      hls.on(HlsClient.Events.MANIFEST_PARSED, () => {
        void playWhenPossible()
      })
      let triedFallback = false
      const loadFallback = () => {
        if (!activeItem.fallbackStreamUrl || triedFallback) return false
        triedFallback = true
        hls.destroy()
        hlsRef.current = null
        setPlayerError('HLS falhou; tentando stream alternativo do Xtream.')
        void (async () => {
          const fallbackUrl = activeItem.fallbackStreamUrl!
          const { default: mpegts } = await import('mpegts.js')
          if (cancelled) return
          const player = mpegts.createPlayer({
            type: fallbackUrl.toLowerCase().includes('.flv') ? 'flv' : 'mpegts',
            isLive: true,
            url: fallbackUrl,
          })
          mpegtsRef.current = player
          player.attachMediaElement(media)
          player.load()
          await playWhenPossible()
        })()
        return true
      }

      hls.on(HlsClient.Events.ERROR, (_event, data: { fatal?: boolean; type?: string; details?: string }) => {
        if (!data.fatal) return

        if (data.type === 'networkError') {
          if (loadFallback()) return
          setPlayerError('Oscilacao de rede. Tentando religar a stream.')
          hls.startLoad()
          return
        }

        if (data.type === 'mediaError') {
          if (loadFallback()) return
          setPlayerError('Erro de midia. Recuperando o player.')
          hls.recoverMediaError()
          return
        }

        setPlayerState('error')
        setPlayerError('A stream recusou o player nativo.')
      })
    }

    void loadStream()

    return () => {
      cancelled = true
      media.removeEventListener('canplay', markReady)
      media.removeEventListener('playing', markPlaying)
      media.removeEventListener('waiting', markWaiting)
      media.removeEventListener('error', markVideoError)
      destroyHls()
      destroyMpegts()
      void destroyShaka()
    }
  }, [activeItem?.fallbackStreamUrl, activeItem?.id, activeItem?.streamUrl, isMuted, reloadToken])

  useEffect(() => {
    copeBufferAbortRef.current?.abort()
    copeBufferChunksRef.current = []
    setCopeBufferSeconds(0)

    if (view !== 'radios' || selectedRadio.id !== 'cope-es') {
      setCopeBufferState('idle')
      return
    }

    const controller = new AbortController()
    copeBufferAbortRef.current = controller
    setCopeBufferState('recording')

    const pruneBuffer = () => {
      const cutoff = Date.now() - COPE_REWIND_LIMIT_MS
      copeBufferChunksRef.current = copeBufferChunksRef.current.filter((entry) => entry.at >= cutoff)
      const firstChunk = copeBufferChunksRef.current[0]
      setCopeBufferSeconds(firstChunk ? Math.max(0, Math.floor((Date.now() - firstChunk.at) / 1000)) : 0)
    }

    const timer = window.setInterval(pruneBuffer, 10_000)

    async function recordCopeBuffer() {
      try {
        const response = await fetch(selectedRadio.streamUrl, {
          cache: 'no-store',
          signal: controller.signal,
        })

        if (!response.ok || !response.body) {
          throw new Error('Sem corpo de audio para buffer.')
        }

        const reader = response.body.getReader()
        while (!controller.signal.aborted) {
          const result = await reader.read()
          if (result.done) break
          copeBufferChunksRef.current.push({ at: Date.now(), chunk: result.value })
          pruneBuffer()
        }
      } catch {
        if (!controller.signal.aborted) setCopeBufferState('blocked')
      }
    }

    void recordCopeBuffer()

    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [selectedRadio.id, selectedRadio.streamUrl, view])

  async function loadPlaylist(event: Event) {
    event.preventDefault()
    const controller = new AbortController()

    try {
      setPlaylistState('loading')
      setPlaylistError('')
      const nextPlaylist = await fetchM3UPlaylist({ url: m3uUrl }, controller.signal)
      setPlaylist(nextPlaylist)
      setSelectedGroup('Todos')
      setSelectedChannelId(nextPlaylist.channels[0]?.id || '')
      setPlaylistState('ready')
      setView('iptv')
    } catch (error) {
      setPlaylistState('error')
      setPlaylistError(error instanceof Error ? error.message : 'Nao foi possivel carregar a playlist.')
    }
  }

  async function loadXtream(event: Event) {
    event.preventDefault()
    const controller = new AbortController()

    try {
      setPlaylistState('loading')
      setPlaylistError('')
      const nextPlaylist = await fetchXtreamPlaylist(
        {
          ...xtream,
          proxyUrl: xtream.proxyUrl?.trim() || DEFAULT_XTREAM_PROXY_URL,
        },
        controller.signal,
      )
      setPlaylist(nextPlaylist)
      setSelectedGroup('Todos')
      setSelectedChannelId(nextPlaylist.channels[0]?.id || '')
      setPlaylistState('ready')
      setView('iptv')
    } catch (error) {
      setPlaylistState('error')
      setPlaylistError(error instanceof Error ? error.message : 'Nao foi possivel entrar no Xtream.')
    }
  }

  async function playActiveVideo() {
    const video = videoRef.current
    if (!video) return

    try {
      video.muted = isMuted
      await video.play()
      setPlayerState('playing')
      setPlayerError('')
    } catch {
      setPlayerState('error')
      setPlayerError('O navegador bloqueou o play automatico. Use o controle nativo do video.')
    }
  }

  function selectNative(feedId: string) {
    setSelectedNativeId(feedId)
    setView('live')
  }

  function selectRadio(radioId: string) {
    setRadioReplayItem(null)
    setSelectedRadioId(radioId)
    setView('radios')
  }

  function selectChannel(channelId: string) {
    setSelectedChannelId(channelId)
    setView('iptv')
  }

  function isFavoriteChannel(channel: Channel) {
    return favoriteChannels.some((favorite) => favorite.streamUrl === channel.streamUrl)
  }

  function toggleFavoriteChannel(channel: Channel) {
    setFavoriteChannels((current) => {
      if (current.some((favorite) => favorite.streamUrl === channel.streamUrl)) {
        return current.filter((favorite) => favorite.streamUrl !== channel.streamUrl)
      }

      return [
        {
          ...channel,
          savedAt: new Date().toISOString(),
        },
        ...current,
      ]
    })
  }

  function playCopeReplay(minutesBack: number) {
    const targetTime = Date.now() - minutesBack * 60_000
    const chunks = copeBufferChunksRef.current.filter((entry) => entry.at >= targetTime)

    if (!chunks.length) {
      setPlayerError('Ainda nao ha buffer suficiente da COPE para esse ponto.')
      return
    }

    if (replayUrlRef.current) URL.revokeObjectURL(replayUrlRef.current)
    const replayUrl = URL.createObjectURL(new Blob(
      chunks.map((entry) => {
        const copy = new Uint8Array(entry.chunk.byteLength)
        copy.set(entry.chunk)
        return copy.buffer
      }),
      { type: 'audio/mpeg' },
    ))
    replayUrlRef.current = replayUrl
    setRadioReplayItem({
      ...radioToPlayerItem(selectedRadio),
      id: `${selectedRadio.id}:replay:${minutesBack}`,
      name: `${selectedRadio.name} - replay`,
      streamUrl: replayUrl,
      href: selectedRadio.href,
      note: `Replay local da COPE a partir de aproximadamente ${minutesBack} min atras. O buffer existe enquanto esta aba fica aberta.`,
    })
    setReloadToken((current) => current + 1)
  }

  function seekRadioRewind(minutesBack: number) {
    if (selectedRadio.id === 'cope-es') {
      playCopeReplay(minutesBack)
      return
    }

    const video = videoRef.current
    const dashPlayer = shakaRef.current
    if (!video || !dashPlayer || !selectedRadio.streamUrl.toLowerCase().includes('.mpd')) {
      setPlayerState('error')
      setPlayerError('Esta radio nao tem arquivo nativo de 2 horas. Use BBC ou COPE com buffer aberto.')
      return
    }

    const seekRange = getMediaSeekRange(video, dashPlayer)
    if (!seekRange) {
      setPlayerState('error')
      setPlayerError('O player ainda esta preparando a janela de rewind. Tente de novo em alguns segundos.')
      return
    }

    const windowSeconds = seekRange.end - seekRange.start
    const offsetSeconds = minutesBack * 60
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
      setPlayerState('error')
      setPlayerError('O player ainda esta preparando a janela de rewind. Tente de novo em alguns segundos.')
      return
    }

    if (windowSeconds < offsetSeconds) {
      setPlayerError(`Esta radio liberou apenas ${Math.floor(windowSeconds / 60)} min de rewind agora.`)
    } else {
      setPlayerError('')
    }

    video.currentTime = Math.max(seekRange.start, seekRange.end - offsetSeconds)
    void video.play().then(() => setPlayerState('playing')).catch(() => setPlayerState('ready'))
  }

  function returnRadioLive() {
    if (replayUrlRef.current) {
      URL.revokeObjectURL(replayUrlRef.current)
      replayUrlRef.current = ''
    }
    setRadioReplayItem(null)

    const video = videoRef.current
    const dashPlayer = shakaRef.current
    if (selectedRadio.streamUrl.toLowerCase().includes('.mpd') && video && dashPlayer) {
      const seekRange = getMediaSeekRange(video, dashPlayer)
      if (seekRange) {
        video.currentTime = seekRange.end
      } else {
        dashPlayer.goToLive?.()
      }
      void video.play().then(() => setPlayerState('playing')).catch(() => setPlayerState('ready'))
      setPlayerError('')
      return
    }

    setReloadToken((current) => current + 1)
  }

  const statusLabel = {
    idle: 'Aguardando',
    loading: 'Carregando',
    ready: 'Pronto',
    playing: 'Ao vivo',
    error: 'Falha',
  }[playerState]

  return (
    <div class="app-shell">
      <header class="app-topbar">
        <div>
          <h1>IPTV Pages Hub</h1>
          <p>Player nativo leve com feeds testados, IPTV Xtream/M3U e radios.</p>
        </div>
        <nav aria-label="Navegacao principal" class="view-tabs">
          {(Object.keys(viewLabels) as AppView[]).map((item) => (
            <button
              class={classNames(view === item && 'active')}
              key={item}
              type="button"
              onClick={() => setView(item)}
            >
              {viewLabels[item]}
            </button>
          ))}
        </nav>
      </header>

      <main class="workspace">
        <section class="player-panel" aria-label="Player nativo">
          <div class={classNames('player-frame', activeItem.mode === 'radio' && 'audio-frame')}>
            {activeItem.mode === 'radio' ? (
              <div class="audio-cover">
                <span>{activeItem.name.slice(0, 2).toUpperCase()}</span>
                <strong>{activeItem.name}</strong>
                <small>{activeItem.source}</small>
              </div>
            ) : null}
            <video
              autoPlay
              key={activeItem.streamUrl}
              ref={videoRef}
              controls
              muted={isMuted}
              playsInline
              poster=""
              onVolumeChange={(event) => setIsMuted((event.currentTarget as HTMLVideoElement).muted)}
            />
            <div class={classNames('player-badge', playerState === 'error' && 'danger', playerState === 'playing' && 'live')}>
              {statusLabel}
            </div>
          </div>

          <div class="now-playing">
            <div>
              <span class="kicker">{activeItem.group}</span>
              <h2>{activeItem.name}</h2>
              <p>{activeItem.note}</p>
            </div>
            <div class="player-actions">
              <button type="button" onClick={() => { void playActiveVideo() }}>
                <Icon name="play" />
                Tocar
              </button>
              <button type="button" onClick={() => setReloadToken((current) => current + 1)}>
                <Icon name="reload" />
                Recarregar
              </button>
              <a href={activeItem.href} rel="noreferrer" target="_blank">
                <Icon name="external" />
                Origem
              </a>
            </div>
          </div>

          <dl class="source-grid">
            <div>
              <dt>Qualidade</dt>
              <dd>{activeItem.quality}</dd>
            </div>
            <div>
              <dt>Regiao</dt>
              <dd>{activeItem.region}</dd>
            </div>
            <div>
              <dt>Fonte</dt>
              <dd>{activeItem.source}</dd>
            </div>
            <div>
              <dt>Stream</dt>
              <dd>{compactUrl(activeItem.streamUrl)}</dd>
            </div>
          </dl>

          {playerError ? <p class="inline-alert">{playerError}</p> : null}
        </section>

        <aside class="guide-panel" aria-label="Guia de canais">
          <div class="guide-head">
            <div>
              <span class="kicker">{viewLabels[view]}</span>
              <h2>{view === 'links' ? 'Fontes externas' : view === 'radios' ? 'Radios' : 'Guia'}</h2>
            </div>
            <label class="search-box">
              <Icon name="search" />
              <input
                placeholder={view === 'iptv' ? 'Buscar na playlist' : view === 'radios' ? 'Buscar radio' : 'Buscar feed'}
                value={query}
                onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
              />
            </label>
          </div>

          {view === 'live' ? (
            <div class="channel-list">
              {filteredNativeFeeds.map((feed) => (
                <button
                  class={classNames('channel-row', selectedNative.id === feed.id && 'selected')}
                  key={feed.id}
                  type="button"
                  onClick={() => selectNative(feed.id)}
                >
                  <span class="channel-mark">{feed.name.slice(0, 2).toUpperCase()}</span>
                  <span>
                    <strong>{feed.name}</strong>
                    <small>{feed.region} - {feed.source}</small>
                  </span>
                  <em>{feed.quality}</em>
                </button>
              ))}
            </div>
          ) : null}

          {view === 'iptv' ? (
            <div class="iptv-panel">
              <div class="source-tabs">
                <button class={classNames(iptvSource === 'm3u' && 'active')} type="button" onClick={() => setIptvSource('m3u')}>M3U</button>
                <button class={classNames(iptvSource === 'xtream' && 'active')} type="button" onClick={() => setIptvSource('xtream')}>Xtream</button>
              </div>

              {iptvSource === 'm3u' ? (
                <form class="playlist-form" onSubmit={loadPlaylist}>
                  <label>
                    <span>Playlist M3U</span>
                    <input
                      placeholder="https://exemplo.com/lista.m3u"
                      value={m3uUrl}
                      onInput={(event) => setM3uUrl((event.currentTarget as HTMLInputElement).value)}
                    />
                  </label>
                  <button disabled={playlistState === 'loading' || !m3uUrl.trim()} type="submit">
                    <Icon name="list" />
                    Carregar
                  </button>
                </form>
              ) : (
                <form class="playlist-form" onSubmit={loadXtream}>
                  <label>
                    <span>Servidor</span>
                    <input
                      placeholder="https://servidor.com:8080"
                      value={xtream.serverUrl}
                      onInput={(event) => setXtream((current) => ({ ...current, serverUrl: (event.currentTarget as HTMLInputElement).value }))}
                    />
                  </label>
                  <div class="form-grid">
                    <label>
                      <span>Usuario</span>
                      <input
                        value={xtream.username}
                        onInput={(event) => setXtream((current) => ({ ...current, username: (event.currentTarget as HTMLInputElement).value }))}
                      />
                    </label>
                    <label>
                      <span>Senha</span>
                      <input
                        type="password"
                        value={xtream.password}
                        onInput={(event) => setXtream((current) => ({ ...current, password: (event.currentTarget as HTMLInputElement).value }))}
                      />
                    </label>
                  </div>
                  <div class="form-grid">
                    <label>
                      <span>Formato</span>
                      <select
                        value={xtream.output}
                        onChange={(event) => setXtream((current) => ({ ...current, output: (event.currentTarget as HTMLSelectElement).value as XtreamCredentials['output'] }))}
                      >
                        <option value="auto">auto</option>
                        <option value="m3u8">m3u8</option>
                        <option value="ts">ts</option>
                      </select>
                    </label>
                    <label>
                      <span>Proxy</span>
                      <input
                        value={xtream.proxyUrl || ''}
                        onInput={(event) => setXtream((current) => ({ ...current, proxyUrl: (event.currentTarget as HTMLInputElement).value }))}
                      />
                    </label>
                  </div>
                  <button disabled={playlistState === 'loading' || !xtream.serverUrl.trim() || !xtream.username.trim() || !xtream.password.trim()} type="submit">
                    <Icon name="list" />
                    Entrar
                  </button>
                </form>
              )}

              <div class="favorite-tabs">
                <button class={classNames(!showFavorites && 'active')} type="button" onClick={() => setShowFavorites(false)}>Todos</button>
                <button class={classNames(showFavorites && 'active')} type="button" onClick={() => setShowFavorites(true)}>
                  <Icon name="star" />
                  Favoritos
                </button>
              </div>

              {playlist ? (
                <div class="playlist-toolbar">
                  <div class="playlist-tools">
                    <select
                      aria-label="Filtrar grupo"
                      disabled={showFavorites}
                      value={selectedGroup}
                      onChange={(event) => setSelectedGroup((event.currentTarget as HTMLSelectElement).value)}
                    >
                      {playlistGroups.map((group) => (
                        <option key={group} value={group}>{group}</option>
                      ))}
                    </select>
                    <span>
                      {showFavorites
                        ? `${filteredFavoriteChannels.length} de ${favoriteChannels.length} favoritos`
                        : `${filteredChannels.length} de ${playlist.channels.length} canais`}
                    </span>
                  </div>
                </div>
              ) : null}

              {playlistError ? <p class="inline-alert">{playlistError}</p> : null}

              <div class="channel-list">
                {displayedChannels.map((channel) => (
                  <div class={classNames('channel-item', selectedChannel?.id === channel.id && 'selected')} key={channel.id}>
                    <button
                      aria-label={isFavoriteChannel(channel) ? `Remover ${channel.name} dos favoritos` : `Favoritar ${channel.name}`}
                      class={classNames('favorite-toggle', isFavoriteChannel(channel) && 'active')}
                      type="button"
                      onClick={() => toggleFavoriteChannel(channel)}
                    >
                      <Icon name="star" />
                    </button>
                    <button
                      class="channel-row"
                      type="button"
                      onClick={() => selectChannel(channel.id)}
                    >
                      <span class="channel-mark">{channel.name.slice(0, 2).toUpperCase()}</span>
                      <span>
                        <strong>{channel.name}</strong>
                        <small>{channel.group}</small>
                      </span>
                      <em>{channel.streamUrl.toLowerCase().includes('.m3u8') ? 'HLS' : channel.streamUrl.toLowerCase().includes('.ts') ? 'TS' : 'Auto'}</em>
                    </button>
                  </div>
                ))}
              </div>

              {showFavorites && !favoriteChannels.length ? (
                <div class="empty-panel">
                  <Icon name="star" />
                  <p>Toque na estrela de qualquer canal para salvar aqui.</p>
                </div>
              ) : null}

              {!playlist && !playlistError && !showFavorites ? (
                <div class="empty-panel">
                  <Icon name="list" />
                  <p>Carregue uma playlist para montar o guia IPTV.</p>
                </div>
              ) : null}
            </div>
          ) : null}

          {view === 'radios' ? (
            <div class="radio-panel">
              {selectedRadio.rewindHours ? (
                <div class="radio-rewind-card">
                  <div>
                    <strong>{selectedRadio.id === 'cope-es' ? 'Buffer local COPE' : 'Rewind da radio'}</strong>
                    <small>
                      {selectedRadio.id === 'cope-es'
                        ? copeBufferState === 'recording'
                          ? `${Math.floor(copeBufferSeconds / 60)} min gravados nesta aba. Para 2 h, deixe a COPE aberta ate completar 120 min.`
                          : copeBufferState === 'blocked'
                            ? 'O navegador bloqueou o buffer local'
                            : 'Abra a COPE para iniciar o buffer'
                        : `Janela nativa de ate ${selectedRadio.rewindHours} h no stream DASH. Use 2 h para voltar direto.`}
                    </small>
                  </div>
                  <div class="rewind-actions">
                    {radioRewindMinutes.map((minutes) => (
                      <button
                        disabled={selectedRadio.id === 'cope-es' && copeBufferSeconds < minutes * 60}
                        key={minutes}
                        type="button"
                        onClick={() => seekRadioRewind(minutes)}
                      >
                        {formatRewindLabel(minutes)}
                      </button>
                    ))}
                    <button disabled={selectedRadio.id === 'cope-es' && !radioReplayItem} type="button" onClick={returnRadioLive}>Ao vivo</button>
                  </div>
                </div>
              ) : (
                <div class="radio-rewind-card">
                  <div>
                    <strong>Sem rewind nativo</strong>
                    <small>Esta origem e apenas ao vivo. Para voltar 2 h direto, use as radios BBC; na COPE o buffer comeca quando a aba fica aberta.</small>
                  </div>
                </div>
              )}

              <div class="channel-list">
                {filteredRadioStations.map((station) => (
                  <button
                    class={classNames('channel-row', selectedRadio.id === station.id && !radioReplayItem && 'selected')}
                    key={station.id}
                    type="button"
                    onClick={() => selectRadio(station.id)}
                  >
                    <span class="channel-mark">{station.name.slice(0, 2).toUpperCase()}</span>
                    <span>
                      <strong>{station.name}</strong>
                      <small>{station.category} - {station.source}</small>
                    </span>
                    <em>{station.streamUrl.toLowerCase().includes('.mpd') ? 'DASH' : 'Audio'}</em>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {view === 'links' ? (
            <div class="link-groups">
              {Object.entries(groupedLinks).map(([group, links]) => (
                <section class="link-group" key={group}>
                  <h3>{group}</h3>
                  {links.map((link) => (
                    <a class="external-row" href={link.href} key={link.id} rel="noreferrer" target="_blank">
                      <span>
                        <strong>{link.name}</strong>
                        <small>{link.reason}</small>
                      </span>
                      <Icon name="external" />
                    </a>
                  ))}
                </section>
              ))}
            </div>
          ) : null}
        </aside>
      </main>
    </div>
  )
}
