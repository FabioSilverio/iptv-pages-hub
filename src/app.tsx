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
  fetchYoutubeStatuses,
  fetchXtreamPlaylist,
  KICK_STATUS_HELP,
  resolveYoutubeChannelInput,
  takeTwitchTokenFromHash,
  TWITCH_STATUS_HELP,
  YOUTUBE_STATUS_HELP,
  type EmbedStatus,
  type EmbedStream,
  type LiveState,
  type M3UCredentials,
  type PersistedConnection,
  type PlaylistSession,
  type XtreamCredentials,
} from './lib/iptv'
import {
  hasOfficialRadioGuide,
  loadRadioGuide,
  type RadioGuideSnapshot,
} from './lib/radio-guide'
import { radioStations, type RadioStation } from './lib/radios'

const CONNECTION_KEY = 'iptv-pages-hub.connection'
const EMBEDS_KEY = 'iptv-pages-hub.embeds'
const SETTINGS_KEY = 'iptv-pages-hub.settings'
const LAST_CHANNEL_KEY = 'iptv-pages-hub.last-channel'
const FAVORITES_KEY = 'iptv-pages-hub.favorites'
const FORM_STATE_KEY = 'iptv-pages-hub.form-state'
const ACTIVE_SURFACE_KEY = 'iptv-pages-hub.active-surface'
const SELECTED_EMBED_KEY = 'iptv-pages-hub.selected-embed'
const SELECTED_RADIO_KEY = 'iptv-pages-hub.selected-radio'
const MOVIES_KEY = 'iptv-pages-hub.movies'
const SELECTED_MOVIE_KEY = 'iptv-pages-hub.selected-movie'
const SHOW_LIVE_NOW_KEY = 'iptv-pages-hub.show-live-now'
const DEFAULT_XTREAM_PROXY_URL = 'https://iptv-pages-hub-proxy.fabiogsilverio.workers.dev'
const RENDER_PROXY_URL = 'https://iptv-pages-hub.vercel.app'
const INITIAL_CHANNEL_BATCH = 180
const CHANNEL_BATCH_STEP = 240
const LIVE_STATUS_REFRESH_MS = 60_000
const PT_BR_NUMBER = new Intl.NumberFormat('pt-BR')
const PT_BR_COLLATOR = new Intl.Collator('pt-BR')

type MediaSurface = 'iptv' | 'twitch' | 'youtube' | 'kick' | 'news' | 'radio' | 'cinema'

interface MovieItem {
  id: string
  title: string
  driveUrl: string
  previewUrl: string
  openUrl: string
}

interface NewsLink {
  id: string
  name: string
  href: string
  note: string
  source: string
  embedUrl?: string
  embedResolver?: 'nasa-live'
  youtubeChannel?: string
  streamUrl?: string
  mirrorChannelKey?: string
  mirrorServers?: string[]
  playbackEngine?: 'dash'
  proxyOverride?: string
}

interface MarketQuote {
  id: string
  label: string
  value: string
  change: string
  trend: 'up' | 'down' | 'flat'
}

interface RadioReplayState {
  streamUrl: string
  title: string
  startedAt: string
  targetOffsetSeconds: number
  source: string
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

interface SiteTransferBundle {
  version: 1
  sourceTab: 'xtream' | 'm3u'
  xtream: XtreamCredentials
  m3u: M3UCredentials
  settings: AppSettings
  embeds: EmbedStream[]
  favorites: string[]
  activeSurface: MediaSurface
  selectedEmbedId: string | null
  selectedRadioId: string
  movies: MovieItem[]
  selectedMovieId: string | null
  showLiveNowPanel: boolean
}

declare global {
  interface Window {
    Twitch?: {
      Embed?: {
        VIDEO_READY?: string
      }
      Player?: new (
        element: HTMLElement | string,
        options: Record<string, unknown>,
      ) => {
        addEventListener?: (event: string, listener: () => void) => void
        destroy?: () => void
        pause?: () => void
        play?: () => void
        setMuted?: (muted: boolean) => void
        setVolume?: (volume: number) => void
      }
    }
    __iptvPagesHubTwitchScript?: Promise<void>
  }
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

function prioritizeCurrentItem<T extends { id: string }>(
  items: T[],
  currentId: string | null | undefined,
): T[] {
  if (!currentId) return items

  const currentIndex = items.findIndex((item) => item.id === currentId)
  if (currentIndex <= 0) return items

  return [items[currentIndex], ...items.slice(0, currentIndex), ...items.slice(currentIndex + 1)]
}

const embedDefaults: EmbedStream[] = [
  { id: 'default:twitch:destiny', platform: 'twitch', channel: 'destiny', title: 'destiny' },
  { id: 'default:twitch:anythingelse', platform: 'twitch', channel: 'anythingelse', title: 'anythingelse' },
  { id: 'default:kick:sneako', platform: 'kick', channel: 'sneako', title: 'sneako' },
  { id: 'default:kick:imreallyimportant', platform: 'kick', channel: 'imreallyimportant', title: 'imreallyimportant' },
]
const mirroredNewsServers = ['sec.ai-hls.site', 'chevy.soyspace.cyou']
const mirroredNewsCache = new Map<string, { streamUrl: string; expiresAt: number }>()
const globalCatchupCache = new Map<string, Array<{
  title: string
  streamUrl: string
  startedAt: string
  durationSeconds: number
  source: string
}>>()
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
    id: 'france-24-english',
    name: 'France 24 English',
    href: 'https://www.youtube.com/@FRANCE24_en/live',
    note: 'Live oficial da France 24 English, resolvida dinamicamente pelo canal oficial no YouTube.',
    source: 'France 24 | YouTube',
    youtubeChannel: '@FRANCE24_en',
  },
  {
    id: 'dw-news-english',
    name: 'DW News English',
    href: 'https://www.youtube.com/@dwnews/live',
    note: 'Live oficial da DW News English, resolvida dinamicamente pelo canal oficial no YouTube.',
    source: 'DW News | YouTube',
    youtubeChannel: '@dwnews',
  },
    {
      id: 'cnn-us',
      name: 'CNN US',
      href: 'https://turnerlive.warnermediacdn.com/hls/live/586495/cnngo/cnn_slate/VIDEO_2_1964000.m3u8',
      note: 'Feed HLS leve da CNN US, validado com playlist e segmentos ao vivo respondendo no browser.',
      source: 'CNN HLS',
      streamUrl: 'https://turnerlive.warnermediacdn.com/hls/live/586495/cnngo/cnn_slate/VIDEO_2_1964000.m3u8',
    },
    {
      id: 'bloomberg-us',
      name: 'Bloomberg US',
      href: 'https://www.bloomberg.com/live',
      note: 'Feed oficial ao vivo da Bloomberg Television US.',
    source: 'Bloomberg',
    streamUrl: 'https://www.bloomberg.com/media-manifest/streams/phoenix-us.m3u8',
  },
  {
    id: 'abc-news-live',
    name: 'ABC News Live',
    href: 'https://abcnews.com/live',
    note: 'ABC News Live oficial, resolvida pelo canal oficial da ABC News no YouTube para abrir rapido no palco.',
    source: 'ABC News | YouTube',
    youtubeChannel: '@ABCNews',
  },
  {
    id: 'times-brasil-cnbc',
    name: 'Times Brasil CNBC',
    href: 'https://www.youtube.com/@otimesbrasil/live',
    note: 'Transmissao oficial ao vivo do Times Brasil, licenciado exclusivo CNBC no Brasil, resolvida pelo canal oficial no YouTube.',
    source: 'Times Brasil | CNBC',
    youtubeChannel: '@otimesbrasil',
  },
  {
    id: 'vatican-news',
    name: 'Vatican News',
    href: 'https://www.comunicazione.va/en/servizi/live.html',
    note: 'Embed oficial do Vatican Media Live, o mesmo usado na pagina oficial do Vaticano.',
    source: 'Vatican Media',
    embedUrl: 'https://www.youtube.com/embed/03pYP2Nmreo?enablejsapi=1&rel=0&modestbranding=1&autoplay=1&mute=1&playsinline=1',
  },
  {
    id: 'nasa-live',
    name: 'NASA TV',
    href: 'https://www.nasa.gov/live/',
    note: 'Embed oficial atual da pagina NASA Live, resolvido automaticamente para abrir no palco sem sair do site.',
    source: 'NASA',
    embedResolver: 'nasa-live',
  },
  {
    id: 'newsmax',
    name: 'Newsmax',
    href: 'https://newsmax-samsungus.amagi.tv/playlist.m3u8',
    note: 'Feed HLS da Newsmax TV via Amagi/Samsung, tocando direto no player leve do site.',
    source: 'Newsmax / Amagi',
    streamUrl: 'https://newsmax-samsungus.amagi.tv/playlist.m3u8',
  },
  {
    id: 'cnbc',
    name: 'CNBC',
    href: 'https://stream.livenewsplay.com:9443/hls/cnbc/cnbcsd.m3u8',
    note: 'Feed HLS 720p da CNBC ao vivo tocando direto no player leve do site.',
    source: 'CNBC',
    streamUrl: 'https://stream.livenewsplay.com:9443/hls/cnbc/cnbcsd.m3u8',
  },
  {
    id: 'fox-news',
    name: 'Fox News',
    href: 'http://247preview.foxnews.com/hls/live/2020027/fncv3preview/primary.m3u8',
    note: 'Feed HLS oficial Fox News Preview 24/7 tocando direto no player do site.',
    source: 'Fox News',
    streamUrl: 'http://247preview.foxnews.com/hls/live/2020027/fncv3preview/primary.m3u8',
  },
  {
    id: 'fox-business',
    name: 'Fox Business',
    href: 'http://41.205.93.154/FOXBUSINESS/index.m3u8',
    note: 'Feed HLS da Fox Business Network via proxy Render (IP direto).',
    source: 'Fox Business Network',
    streamUrl: 'http://41.205.93.154/FOXBUSINESS/index.m3u8',
    proxyOverride: RENDER_PROXY_URL,
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

function statusTone(state: LiveState, platform?: 'twitch' | 'youtube' | 'kick') {
  if (state === 'online') return classNames('status-chip', 'online', platform)
  if (state === 'offline') return classNames('status-chip', 'offline', platform)
  if (state === 'error') return classNames('status-chip', 'error', platform)
  return classNames('status-chip', 'unknown', platform)
}

function feedPillTone(platform?: 'twitch' | 'youtube' | 'kick', active = false) {
  return classNames('feed-pill', 'button-pill', platform, active && 'active')
}

function isTokenFresh(expiresAt?: string) {
  if (!expiresAt) return false
  const expiry = Date.parse(expiresAt)
  return Number.isFinite(expiry) && expiry > Date.now() + 30_000
}

function buildKickEmbedUrl(channel: string) {
  return `https://player.kick.com/${channel}?autoplay=true&muted=true`
}

function withAutoplayEmbedUrl(rawUrl?: string) {
  if (!rawUrl) return ''

  try {
    const url = new URL(rawUrl)
    const hostname = url.hostname.toLowerCase()

    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
      url.searchParams.set('autoplay', '1')
      url.searchParams.set('mute', '1')
      url.searchParams.set('playsinline', '1')
      url.searchParams.set('enablejsapi', '1')
      url.searchParams.set('rel', '0')
      url.searchParams.set('modestbranding', '1')
    }

    if (hostname.includes('player.kick.com')) {
      url.searchParams.set('autoplay', 'true')
      url.searchParams.set('muted', 'true')
    }

    return url.toString()
  } catch {
    return rawUrl
  }
}

async function ensureTwitchPlayerScript() {
  if (window.Twitch?.Player) return
  if (window.__iptvPagesHubTwitchScript) {
    await window.__iptvPagesHubTwitchScript
    return
  }

  window.__iptvPagesHubTwitchScript = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-twitch-player-script="true"]')
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Falha ao carregar o player da Twitch.')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = 'https://player.twitch.tv/js/embed/v1.js'
    script.async = true
    script.dataset.twitchPlayerScript = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Falha ao carregar o player da Twitch.'))
    document.head.appendChild(script)
  })

  await window.__iptvPagesHubTwitchScript
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

function buildDashboardTimes(now: Date) {
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
}

function formatWindowLabel(seconds: number) {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`
}

function parseDurationToSeconds(value: string) {
  const normalized = String(value || '').trim()
  if (!normalized) return 0

  const parts = normalized.split(':').map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part))) return 0

  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0]
}

function hasHttpUrl(value: string) {
  return value.trim().toLowerCase().startsWith('http://')
}

function toHttpsUrl(value: string) {
  return value.trim().replace(/^http:\/\//i, 'https://')
}

async function resolveMirroredNewsStream(channelKey: string, servers: string[]) {
  const cached = mirroredNewsCache.get(channelKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.streamUrl
  }

  for (const domain of servers) {
    try {
      const response = await fetch(`https://${domain}/server_lookup?channel_id=${encodeURIComponent(channelKey)}`)
      if (!response.ok) {
        continue
      }

      const payload = (await response.json()) as { server_key?: string }
      const serverKey = String(payload.server_key || '').trim()
      if (!serverKey) {
        continue
      }

      const route = serverKey === 'top1/cdn' ? 'top1/cdn' : serverKey
      const streamUrl = `https://${domain}/proxy/${route}/${channelKey}/mono.m3u8`
      mirroredNewsCache.set(channelKey, {
        streamUrl,
        expiresAt: Date.now() + 5 * 60_000,
      })
      return streamUrl
    } catch {
      // Try the next mirror host.
    }
  }

  throw new Error('Nao consegui resolver o feed espelhado agora.')
}

async function resolveOfficialNasaEmbed(proxyBase: string) {
  const response = await fetch(buildProxyUrl(proxyBase, 'https://www.nasa.gov/live/'), {
    headers: {
      Accept: 'text/html',
      'User-Agent': 'Mozilla/5.0',
    },
  })

  if (!response.ok) {
    throw new Error('A pagina oficial da NASA nao respondeu agora.')
  }

  const html = await response.text()
  const iframeMatch = html.match(/<iframe[^>]+src="https:\/\/www\.youtube\.com\/embed\/([A-Za-z0-9_-]{11})[^"]*"/i)
  const iframeVideoId = iframeMatch?.[1]

  if (iframeVideoId) {
    return `https://www.youtube.com/embed/${iframeVideoId}?enablejsapi=1&rel=0&modestbranding=1&autoplay=1&mute=1&playsinline=1`
  }

  const matches = [...html.matchAll(/https:\/\/www\.youtube\.com\/embed\/([A-Za-z0-9_-]{11})/g)]
  const videoId = (matches.length ? matches[matches.length - 1]?.[1] : '') || matches[0]?.[1]

  if (!videoId) {
    throw new Error('Nao consegui identificar o embed oficial atual da NASA.')
  }

  return `https://www.youtube.com/embed/${videoId}?enablejsapi=1&rel=0&modestbranding=1&autoplay=1&mute=1&playsinline=1`
}

function extractNextDataJson(html: string) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i)
  if (!match) {
    throw new Error('Nao consegui ler os dados oficiais dessa pagina.')
  }

  return JSON.parse(match[1]) as {
    props?: {
      pageProps?: Record<string, unknown>
    }
  }
}

async function fetchGlobalCatchupEpisodes(
  catchupIndexHref: string,
  proxyUrl: string,
) {
  const cached = globalCatchupCache.get(catchupIndexHref)
  if (cached) return cached

  const indexResponse = await fetch(buildProxyUrl(proxyUrl, catchupIndexHref), {
    headers: { Accept: 'text/html' },
  })

  if (!indexResponse.ok) {
    throw new Error('Nao consegui abrir o catch up oficial agora.')
  }

  const indexHtml = await indexResponse.text()
  const indexData = extractNextDataJson(indexHtml)
  const pageProps = indexData.props?.pageProps as { catchupInfo?: Array<{ id?: string; title?: string }> } | undefined
  const shows = Array.isArray(pageProps?.catchupInfo) ? pageProps!.catchupInfo : []
  const showIds = shows
    .map((show) => String(show.id || '').trim())
    .filter(Boolean)
    .slice(0, 24)

  const episodeGroups = await Promise.all(
    showIds.map(async (showId) => {
      const showHref = catchupIndexHref.endsWith('/') ? `${catchupIndexHref}${showId}/` : `${catchupIndexHref}/${showId}/`
      const response = await fetch(buildProxyUrl(proxyUrl, showHref), {
        headers: { Accept: 'text/html' },
      })

      if (!response.ok) return []

      const html = await response.text()
      const data = extractNextDataJson(html)
      const showProps = data.props?.pageProps as {
        catchupInfo?: {
          title?: string
          episodes?: Array<{
            title?: string
            streamUrl?: string
            startDate?: string
            duration?: string
          }>
        }
      } | undefined

      const sourceTitle = String(showProps?.catchupInfo?.title || '').trim()

      return (showProps?.catchupInfo?.episodes || [])
        .map((episode) => ({
          title: String(episode.title || sourceTitle || 'Programa recente').trim(),
          streamUrl: String(episode.streamUrl || '').trim(),
          startedAt: String(episode.startDate || '').trim(),
          durationSeconds: parseDurationToSeconds(String(episode.duration || '')),
          source: sourceTitle,
        }))
        .filter((episode) => episode.streamUrl && episode.startedAt && episode.durationSeconds > 0)
    }),
  )

  const episodes = episodeGroups.flat().sort(
    (left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt),
  )

  globalCatchupCache.set(catchupIndexHref, episodes)
  return episodes
}

async function resolveGlobalCatchupReplay(
  station: RadioStation,
  secondsBack: number,
  proxyUrl: string,
) {
  if (!station.catchupIndexHref) {
    throw new Error('Essa radio nao tem catch up oficial configurado.')
  }

  const episodes = await fetchGlobalCatchupEpisodes(station.catchupIndexHref, proxyUrl)
  const targetTime = Date.now() - secondsBack * 1000

  const containingEpisode = episodes.find((episode) => {
    const start = Date.parse(episode.startedAt)
    const end = start + episode.durationSeconds * 1000
    return Number.isFinite(start) && targetTime >= start && targetTime <= end
  })

  if (containingEpisode) {
    return {
      streamUrl: containingEpisode.streamUrl,
      title: containingEpisode.title,
      startedAt: containingEpisode.startedAt,
      targetOffsetSeconds: secondsBack,
      source: containingEpisode.source || station.name,
    }
  }

  const closestEpisode = episodes.find((episode) => Date.parse(episode.startedAt) <= targetTime) || episodes[0]
  if (!closestEpisode) {
    throw new Error('Nao achei um programa recente para esse horario.')
  }

  return {
    streamUrl: closestEpisode.streamUrl,
    title: closestEpisode.title,
    startedAt: closestEpisode.startedAt,
    targetOffsetSeconds: secondsBack,
    source: closestEpisode.source || station.name,
  }
}

function formatXtreamError(error: unknown, credentials: XtreamCredentials) {
  const serverUrl = credentials.serverUrl
  const hasProxy = Boolean(credentials.proxyUrl?.trim())

  if (hasHttpUrl(serverUrl) && window.location.protocol === 'https:' && !hasProxy) {
    return `GitHub Pages abriu em HTTPS, mas esse Xtream esta em HTTP (${serverUrl.trim()}). O navegador bloqueia esse login. Tente a versao https:// do servidor. Se o provedor so responder em HTTP, vai precisar de proxy ou backend.`
  }
  if (error instanceof Error && /Direct IP access not allowed|HTML\/403|403/i.test(error.message)) {
    return 'A origem bloqueou o proxy HTTPS atual. Esse host HTTP parece barrar o worker da Cloudflare. Tente um proxy HTTPS alternativo fora do Cloudflare para essa playlist.'
  }
  if (error instanceof TypeError) {
    return hasProxy
      ? 'Falha de rede ao consultar o Xtream via proxy. O worker pode estar ok, mas o provedor pode estar offline, lento ou recusando essa origem agora.'
      : 'Falha de rede ao consultar o Xtream. O servidor pode estar offline, sem CORS ou recusando acesso do navegador.'
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

function extractDriveFileId(rawUrl: string) {
  const value = rawUrl.trim()
  if (!value) return ''

  const directMatch = value.match(/\/file\/d\/([a-zA-Z0-9_-]+)/i)
  if (directMatch?.[1]) return directMatch[1]

  try {
    const url = new URL(value)
    const paramId = url.searchParams.get('id')
    if (paramId) return paramId
  } catch {
    return ''
  }

  return ''
}

function buildDrivePreviewUrl(rawUrl: string) {
  const fileId = extractDriveFileId(rawUrl)
  return fileId ? `https://drive.google.com/file/d/${fileId}/preview` : ''
}

function buildDriveOpenUrl(rawUrl: string) {
  const fileId = extractDriveFileId(rawUrl)
  return fileId ? `https://drive.google.com/file/d/${fileId}/view` : rawUrl.trim()
}

function normalizeEmbeds(value: unknown) {
  if (!Array.isArray(value)) return embedDefaults

  const normalized: EmbedStream[] = []

  value.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const candidate = item as Partial<EmbedStream>
    const platform =
      candidate.platform === 'kick'
        ? 'kick'
        : candidate.platform === 'twitch'
          ? 'twitch'
          : candidate.platform === 'youtube'
            ? 'youtube'
            : null
    const channel = String(candidate.channel || '').trim()
    if (!platform || !channel) return

    const statusEndpoint = String(candidate.statusEndpoint || '').trim()
    normalized.push({
      id: String(candidate.id || `${platform}:${channel}:${index}`),
      platform,
      channel,
      title: String(candidate.title || channel).trim() || channel,
      ...(statusEndpoint ? { statusEndpoint } : {}),
    })
  })

  return normalized
}

function normalizeMovies(value: unknown): MovieItem[] {
  if (!Array.isArray(value)) return []

  return value.reduce<MovieItem[]>((items, entry, index) => {
    if (!entry || typeof entry !== 'object') return items
    const candidate = entry as Partial<MovieItem>
    const driveUrl = String(candidate.driveUrl || '').trim()
    const previewUrl = buildDrivePreviewUrl(driveUrl)
    const openUrl = buildDriveOpenUrl(driveUrl)
    if (!driveUrl || !previewUrl) return items

    items.push({
      id: String(candidate.id || `movie:${index}:${previewUrl}`),
      title: String(candidate.title || `Filme ${index + 1}`).trim() || `Filme ${index + 1}`,
      driveUrl,
      previewUrl,
      openUrl,
    })

    return items
  }, [])
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

function isLikelyDashStream(streamUrl: string) {
  return extractTargetStreamUrl(streamUrl).toLowerCase().includes('.mpd')
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
  if (isLikelyDashStream(channel.streamUrl)) {
    return [{ url: channel.streamUrl, engine: 'dash' as const }]
  }

  const primaryIsHls = isLikelyHlsStream(channel.streamUrl)
  const fallbackIsTs = Boolean(channel.fallbackStreamUrl && isLikelyTsStream(channel.fallbackStreamUrl))
  const orderedSources = primaryIsHls && fallbackIsTs
    ? [
        channel.streamUrl,
        channel.fallbackStreamUrl,
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
    engine: isLikelyDashStream(url) ? 'dash' : isLikelyHlsStream(url) ? 'hls' : isLikelyTsStream(url) ? 'mpegts' : 'native',
  }))
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function stabilizeRadioStartup(media: HTMLMediaElement) {
  if (media.readyState >= 3) {
    await delay(700)
    return
  }

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      media.removeEventListener('canplay', finish)
      media.removeEventListener('loadeddata', finish)
      resolve()
    }

    media.addEventListener('canplay', finish, { once: true })
    media.addEventListener('loadeddata', finish, { once: true })
    window.setTimeout(finish, 2200)
  })

  await delay(900)
}

async function attemptMediaPlayback(
  media: HTMLMediaElement,
  stateOnBlocked: string,
  options?: { stabilizeRadio?: boolean },
) {
  try {
    if (options?.stabilizeRadio) {
      await stabilizeRadioStartup(media)
    }

    await media.play()
    return 'Ao vivo'
  } catch {
    return stateOnBlocked
  }
}

function LiveDashboardMeta() {
  const [clockTick, setClockTick] = useState(() => Date.now())
  const [marketQuotes, setMarketQuotes] = useState<MarketQuote[]>([])

  const dashboardTimes = useMemo(
    () => buildDashboardTimes(new Date(clockTick)),
    [clockTick],
  )

  useEffect(() => {
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

  return (
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
  )
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
  const [movies, setMovies] = useState<MovieItem[]>(() => normalizeMovies(readJson<unknown[]>(MOVIES_KEY, [])))
  const [embedDraft, setEmbedDraft] = useState<EmbedStream>({ id: '', platform: 'twitch', channel: '', title: '', statusEndpoint: '' })
  const [movieDraft, setMovieDraft] = useState({ title: '', driveUrl: '' })
  const [statusMap, setStatusMap] = useState<Record<string, EmbedStatus>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [transferMessage, setTransferMessage] = useState('')
  const [playerError, setPlayerError] = useState('')
  const [playerState, setPlayerState] = useState('Pronto para tocar')
  const [visibleCount, setVisibleCount] = useState(INITIAL_CHANNEL_BATCH)
  const [activeSurface, setActiveSurface] = useState<MediaSurface>(
    () => readJson<MediaSurface>(ACTIVE_SURFACE_KEY, 'iptv'),
  )
  const [selectedNewsId, setSelectedNewsId] = useState(newsLinks[0].id)
  const [selectedRadioId, setSelectedRadioId] = useState<string>(() => readJson<string>(SELECTED_RADIO_KEY, radioStations[0]?.id || ''))
  const [selectedMovieId, setSelectedMovieId] = useState<string | null>(() => window.localStorage.getItem(SELECTED_MOVIE_KEY))
  const [resolvedNewsStreamUrl, setResolvedNewsStreamUrl] = useState('')
  const [resolvedNewsEmbedUrl, setResolvedNewsEmbedUrl] = useState('')
  const [newsMirrorState, setNewsMirrorState] = useState<'idle' | 'resolving' | 'ready' | 'failed'>('idle')
  const [newsMirrorError, setNewsMirrorError] = useState('')
  const [selectedEmbedId, setSelectedEmbedId] = useState<string | null>(
    () => window.localStorage.getItem(SELECTED_EMBED_KEY),
  )
  const [showConnectionPanel, setShowConnectionPanel] = useState(true)
  const [showLiveNowPanel, setShowLiveNowPanel] = useState(
    () => readJson<boolean>(SHOW_LIVE_NOW_KEY, false),
  )
  const [showIptvPanel, setShowIptvPanel] = useState(true)
  const [showTwitchPanel, setShowTwitchPanel] = useState(true)
  const [showYouTubePanel, setShowYouTubePanel] = useState(true)
  const [showKickPanel, setShowKickPanel] = useState(true)
  const [showNewsPanel, setShowNewsPanel] = useState(true)
  const [showRadioPanel, setShowRadioPanel] = useState(true)
  const [showCinemaPanel, setShowCinemaPanel] = useState(true)
  const [newsStripLeftReady, setNewsStripLeftReady] = useState(false)
  const [newsStripRightReady, setNewsStripRightReady] = useState(false)
  const [newsShortcutLeftReady, setNewsShortcutLeftReady] = useState(false)
  const [newsShortcutRightReady, setNewsShortcutRightReady] = useState(false)
  const [mediaStripLeftReady, setMediaStripLeftReady] = useState(false)
  const [mediaStripRightReady, setMediaStripRightReady] = useState(false)
  const [radioSeekWindowSeconds, setRadioSeekWindowSeconds] = useState(0)
  const [radioReplay, setRadioReplay] = useState<RadioReplayState | null>(null)
  const [radioGuide, setRadioGuide] = useState<RadioGuideSnapshot | null>(null)
  const [radioGuideError, setRadioGuideError] = useState('')
  const [radioGuideState, setRadioGuideState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const videoRef = useRef<HTMLMediaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const siteBackupInputRef = useRef<HTMLInputElement | null>(null)
  const newsStripRef = useRef<HTMLDivElement | null>(null)
  const newsShortcutRef = useRef<HTMLDivElement | null>(null)
  const mediaStripRef = useRef<HTMLDivElement | null>(null)
  const twitchPlayerHostRef = useRef<HTMLDivElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  const twitchPlayerRef = useRef<{
    destroy?: () => void
    pause?: () => void
    play?: () => void
    setMuted?: (muted: boolean) => void
    setVolume?: (volume: number) => void
  } | null>(null)
  const dashRef = useRef<{ reset: () => Promise<unknown> | unknown } | null>(null)
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
  const normalizedSearch = searchTerm.trim().toLowerCase()
  const visibleChannels = useMemo(
    () =>
      channels
        .filter((channel) => {
          const matchesGroup = groupFilter === 'Todos' || channel.group === groupFilter
          const matchesSearch =
            !normalizedSearch ||
            channel.name.toLowerCase().includes(normalizedSearch) ||
            channel.group.toLowerCase().includes(normalizedSearch) ||
            channel.tvgId?.toLowerCase().includes(normalizedSearch)
          return matchesGroup && matchesSearch
        })
        .sort((left, right) => {
          const leftFavorite = favoriteIds.has(left.id) ? 1 : 0
          const rightFavorite = favoriteIds.has(right.id) ? 1 : 0
          if (leftFavorite !== rightFavorite) return rightFavorite - leftFavorite
          const groupCompare = PT_BR_COLLATOR.compare(left.group, right.group)
          if (groupCompare !== 0) return groupCompare
          return PT_BR_COLLATOR.compare(left.name, right.name)
        }),
    [channels, favoriteIds, groupFilter, normalizedSearch],
  )
  const displayedChannels = useMemo(
    () => visibleChannels.slice(0, visibleCount),
    [visibleChannels, visibleCount],
  )
  const twitchEmbeds = useMemo(
    () => embeds.filter((item) => item.platform === 'twitch'),
    [embeds],
  )
  const youtubeEmbeds = useMemo(
    () => embeds.filter((item) => item.platform === 'youtube'),
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
  const sortedYouTubeEmbeds = useMemo(
    () => sortEmbedsByStatus(youtubeEmbeds),
    [statusMap, youtubeEmbeds],
  )
  const sortedKickEmbeds = useMemo(
    () => sortEmbedsByStatus(kickEmbeds),
    [kickEmbeds, statusMap],
  )
  const liveEmbeds = useMemo(
    () =>
      [...sortedTwitchEmbeds, ...sortedYouTubeEmbeds, ...sortedKickEmbeds].filter(
        (item) => statusMap[item.channel.toLowerCase()]?.state === 'online',
      ),
    [sortedKickEmbeds, sortedTwitchEmbeds, sortedYouTubeEmbeds, statusMap],
  )
  const onlineTwitchCount = useMemo(
    () => sortedTwitchEmbeds.filter((item) => statusMap[item.channel.toLowerCase()]?.state === 'online').length,
    [sortedTwitchEmbeds, statusMap],
  )
  const onlineYouTubeCount = useMemo(
    () => sortedYouTubeEmbeds.filter((item) => statusMap[item.channel.toLowerCase()]?.state === 'online').length,
    [sortedYouTubeEmbeds, statusMap],
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
    const pool =
      activeSurface === 'twitch'
        ? sortedTwitchEmbeds
        : activeSurface === 'youtube'
          ? sortedYouTubeEmbeds
          : activeSurface === 'kick'
            ? sortedKickEmbeds
            : []
    return pool.find((item) => item.id === selectedEmbedId) ?? pool[0] ?? null
  }, [activeSurface, selectedEmbedId, sortedKickEmbeds, sortedTwitchEmbeds, sortedYouTubeEmbeds])
  const activeFeedItems = useMemo(
    () => {
      const pool =
        activeSurface === 'twitch'
          ? sortedTwitchEmbeds
          : activeSurface === 'youtube'
            ? sortedYouTubeEmbeds
            : activeSurface === 'kick'
              ? sortedKickEmbeds
              : []

      return prioritizeCurrentItem(pool, activeEmbed?.id)
    },
    [activeEmbed?.id, activeSurface, sortedKickEmbeds, sortedTwitchEmbeds, sortedYouTubeEmbeds],
  )
  const selectedNewsLink = useMemo(
    () => newsLinks.find((item) => item.id === selectedNewsId) ?? newsLinks[0],
    [selectedNewsId],
  )
  const orderedNewsLinks = useMemo(
    () => prioritizeCurrentItem(newsLinks, selectedNewsLink.id),
    [selectedNewsLink.id],
  )
  const selectedRadioStation = useMemo<RadioStation | null>(
    () => radioStations.find((item) => item.id === selectedRadioId) ?? radioStations[0] ?? null,
    [selectedRadioId],
  )
  const selectedMovie = useMemo<MovieItem | null>(
    () => movies.find((item) => item.id === selectedMovieId) ?? movies[0] ?? null,
    [movies, selectedMovieId],
  )
  const selectedRadioScheduleHref = selectedRadioStation?.scheduleHref || selectedRadioStation?.href || ''
  const canShowRadioGuide = useMemo(
    () => hasOfficialRadioGuide(selectedRadioStation),
    [selectedRadioStation],
  )
  const selectedNewsPlayback = useMemo<Channel | null>(() => {
    const resolvedStream = selectedNewsLink.mirrorChannelKey
      ? resolvedNewsStreamUrl
      : selectedNewsLink.streamUrl

    if (!resolvedStream) return null
    let streamUrl: string
    if (selectedNewsLink.playbackEngine === 'dash') {
      streamUrl = resolvedStream
    } else if (selectedNewsLink.proxyOverride) {
      streamUrl = `${selectedNewsLink.proxyOverride}/api/proxy?url=${encodeURIComponent(resolvedStream)}`
    } else {
      streamUrl = buildProxyUrl(DEFAULT_XTREAM_PROXY_URL, resolvedStream)
    }

    return {
      id: `news:${selectedNewsLink.id}`,
      name: selectedNewsLink.name,
      group: 'Noticias',
      streamUrl,
    }
  }, [resolvedNewsStreamUrl, selectedNewsLink])
  const selectedNewsEmbedUrl = useMemo(
    () => withAutoplayEmbedUrl(resolvedNewsEmbedUrl || selectedNewsLink.embedUrl || ''),
    [resolvedNewsEmbedUrl, selectedNewsLink.embedUrl],
  )
  const selectedRadioPlayback = useMemo<Channel | null>(() => {
    if (!selectedRadioStation) return null

    return {
      id: radioReplay
        ? `radio:${selectedRadioStation.id}:replay:${radioReplay.startedAt}:${radioReplay.targetOffsetSeconds}`
        : `radio:${selectedRadioStation.id}:live`,
      name: radioReplay ? `${selectedRadioStation.name} · ${radioReplay.title}` : selectedRadioStation.name,
      group: 'Radios',
      streamUrl: radioReplay?.streamUrl || selectedRadioStation.streamUrl,
    }
  }, [radioReplay, selectedRadioStation])
  const selectedPlaybackChannel = useMemo<Channel | null>(() => {
    if (activeSurface === 'iptv') return selectedChannel
    if (activeSurface === 'news') return selectedNewsPlayback
    if (activeSurface === 'radio') return selectedRadioPlayback
    return null
  }, [activeSurface, selectedChannel, selectedNewsPlayback, selectedRadioPlayback])
  const radioCategoryCounts = useMemo(
    () =>
      radioStations.reduce<Record<string, number>>((groups, station) => {
        groups[station.category] = (groups[station.category] || 0) + 1
        return groups
      }, {}),
    [],
  )
  const radioWindowLabel = useMemo(
    () => (radioSeekWindowSeconds >= 60 ? formatWindowLabel(radioSeekWindowSeconds) : ''),
    [radioSeekWindowSeconds],
  )
  const radioPlaybackBadge = useMemo(() => {
    if (radioReplay) {
      return `Replay ${formatWindowLabel(radioReplay.targetOffsetSeconds)} atras`
    }

    return 'Ao vivo'
  }, [radioReplay])
  const radioPlaybackDetail = useMemo(() => {
    if (!radioReplay) {
      return radioWindowLabel ? `Janela ao vivo ${radioWindowLabel}` : 'Ao vivo oficial'
    }

    const startedAt = Date.parse(radioReplay.startedAt)
    const startedLabel = Number.isFinite(startedAt)
      ? new Intl.DateTimeFormat('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(startedAt))
      : ''

    return startedLabel
      ? `${radioReplay.title} · ${startedLabel}`
      : radioReplay.title
  }, [radioReplay, radioWindowLabel])
  const radioGuideUpdatedLabel = useMemo(() => {
    if (!radioGuide?.updatedAt) return ''

    return new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/London',
    }).format(new Date(radioGuide.updatedAt))
  }, [radioGuide?.updatedAt])
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

  function syncNewsShortcutState() {
    const node = newsShortcutRef.current

    if (!node) {
      setNewsShortcutLeftReady(false)
      setNewsShortcutRightReady(false)
      return
    }

    const maxScroll = Math.max(0, node.scrollWidth - node.clientWidth)
    const canScroll = maxScroll > 8
    setNewsShortcutLeftReady(canScroll && node.scrollLeft > 8)
    setNewsShortcutRightReady(canScroll && node.scrollLeft < maxScroll - 8)
  }

  function scrollNewsShortcut(direction: 'left' | 'right') {
    const node = newsShortcutRef.current
    if (!node) return

    node.scrollBy({
      left: (direction === 'right' ? 1 : -1) * Math.max(220, node.clientWidth * 0.68),
      behavior: 'smooth',
    })
  }

  function syncMediaStripState() {
    const node = mediaStripRef.current
    const hasMediaStrip = activeSurface === 'twitch' || activeSurface === 'youtube' || activeSurface === 'kick'

    if (!node || !hasMediaStrip) {
      setMediaStripLeftReady(false)
      setMediaStripRightReady(false)
      return
    }

    const maxScroll = Math.max(0, node.scrollWidth - node.clientWidth)
    const canScroll = maxScroll > 8
    setMediaStripLeftReady(canScroll && node.scrollLeft > 8)
    setMediaStripRightReady(canScroll && node.scrollLeft < maxScroll - 8)
  }

  function scrollMediaStrip(direction: 'left' | 'right') {
    const node = mediaStripRef.current
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
    let cancelled = false

    const resolveNews = async () => {
      setNewsMirrorError('')
      setResolvedNewsEmbedUrl('')

      if (selectedNewsLink.mirrorChannelKey) {
        setResolvedNewsStreamUrl('')
        setNewsMirrorState('resolving')

        try {
          const streamUrl = await resolveMirroredNewsStream(
            selectedNewsLink.mirrorChannelKey,
            selectedNewsLink.mirrorServers || mirroredNewsServers,
          )

          if (!cancelled) {
            setResolvedNewsStreamUrl(streamUrl)
            setNewsMirrorState('ready')
          }
        } catch (error) {
          if (!cancelled) {
            setResolvedNewsStreamUrl('')
            setNewsMirrorState('failed')
            setNewsMirrorError(error instanceof Error ? error.message : 'Falha ao resolver o feed espelhado.')
          }
        }
        return
      }

      if (selectedNewsLink.embedResolver === 'nasa-live') {
        setResolvedNewsStreamUrl('')
        setNewsMirrorState('resolving')

        try {
          const embedUrl = await resolveOfficialNasaEmbed(DEFAULT_XTREAM_PROXY_URL)
          if (!cancelled) {
            setResolvedNewsEmbedUrl(embedUrl)
            setNewsMirrorState('ready')
          }
        } catch (error) {
          if (!cancelled) {
            setNewsMirrorState('failed')
            setNewsMirrorError(error instanceof Error ? error.message : 'Falha ao resolver o embed oficial da NASA.')
          }
        }
        return
      }

      if (selectedNewsLink.youtubeChannel) {
        setResolvedNewsStreamUrl('')
        setNewsMirrorState('resolving')

        try {
          const statuses = await fetchYoutubeStatuses(
            [selectedNewsLink.youtubeChannel],
            DEFAULT_XTREAM_PROXY_URL,
          )
          const status = statuses[selectedNewsLink.youtubeChannel.toLowerCase()]

          if (!cancelled) {
            if (status?.state === 'online' && status.playbackUrl) {
              setResolvedNewsEmbedUrl(status.playbackUrl)
              setNewsMirrorState('ready')
            } else {
              setNewsMirrorState('failed')
              setNewsMirrorError(
                status?.detail || 'O canal oficial do YouTube nao devolveu uma live ativa agora.',
              )
            }
          }
        } catch (error) {
          if (!cancelled) {
            setNewsMirrorState('failed')
            setNewsMirrorError(
              error instanceof Error ? error.message : 'Falha ao resolver o canal oficial da ABC News.',
            )
          }
        }
        return
      }

      setResolvedNewsStreamUrl(selectedNewsLink.streamUrl || '')
      setNewsMirrorState(selectedNewsLink.streamUrl || selectedNewsLink.embedUrl ? 'ready' : 'idle')
    }

    void resolveNews()

    return () => {
      cancelled = true
    }
  }, [selectedNewsLink])

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
  useEffect(() => saveJson(MOVIES_KEY, movies), [movies])
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
    const node = newsShortcutRef.current
    if (!node) {
      syncNewsShortcutState()
      return
    }

    const handleScroll = () => syncNewsShortcutState()
    const handleResize = () => syncNewsShortcutState()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null

    node.addEventListener('scroll', handleScroll, { passive: true })
    observer?.observe(node)
    window.addEventListener('resize', handleResize)
    window.requestAnimationFrame(syncNewsShortcutState)

    return () => {
      node.removeEventListener('scroll', handleScroll)
      observer?.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  useEffect(() => {
    const hasMediaStrip = activeSurface === 'twitch' || activeSurface === 'youtube' || activeSurface === 'kick'
    if (!hasMediaStrip) {
      syncMediaStripState()
      return
    }

    const node = mediaStripRef.current
    if (!node) {
      syncMediaStripState()
      return
    }

    const handleScroll = () => syncMediaStripState()
    const handleResize = () => syncMediaStripState()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null

    node.addEventListener('scroll', handleScroll, { passive: true })
    observer?.observe(node)
    window.addEventListener('resize', handleResize)
    window.requestAnimationFrame(syncMediaStripState)

    return () => {
      node.removeEventListener('scroll', handleScroll)
      observer?.disconnect()
      window.removeEventListener('resize', handleResize)
    }
  }, [activeSurface, selectedEmbedId, activeFeedItems.length])
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
    if (selectedRadioId) window.localStorage.setItem(SELECTED_RADIO_KEY, selectedRadioId)
  }, [selectedRadioId])
  useEffect(() => {
    if (selectedMovieId) {
      window.localStorage.setItem(SELECTED_MOVIE_KEY, selectedMovieId)
      return
    }

    window.localStorage.removeItem(SELECTED_MOVIE_KEY)
  }, [selectedMovieId])

  useEffect(() => {
    if (activeSurface === 'twitch' && !twitchEmbeds.length) {
      if (youtubeEmbeds.length) {
        setActiveSurface('youtube')
        setSelectedEmbedId(youtubeEmbeds[0].id)
      } else if (kickEmbeds.length) {
        setActiveSurface('kick')
        setSelectedEmbedId(kickEmbeds[0].id)
      } else {
        setActiveSurface('iptv')
      }
      return
    }

    if (activeSurface === 'youtube' && !youtubeEmbeds.length) {
      if (kickEmbeds.length) {
        setActiveSurface('kick')
        setSelectedEmbedId(kickEmbeds[0].id)
      } else if (twitchEmbeds.length) {
        setActiveSurface('twitch')
        setSelectedEmbedId(twitchEmbeds[0].id)
      } else {
        setActiveSurface('iptv')
      }
      return
    }

    if (activeSurface === 'kick' && !kickEmbeds.length) {
      if (youtubeEmbeds.length) {
        setActiveSurface('youtube')
        setSelectedEmbedId(youtubeEmbeds[0].id)
      } else if (twitchEmbeds.length) {
        setActiveSurface('twitch')
        setSelectedEmbedId(twitchEmbeds[0].id)
      } else {
        setActiveSurface('iptv')
      }
      return
    }

    if ((activeSurface === 'twitch' || activeSurface === 'youtube' || activeSurface === 'kick') && activeEmbed) {
      setSelectedEmbedId(activeEmbed.id)
    }
  }, [activeEmbed, activeSurface, kickEmbeds, twitchEmbeds, youtubeEmbeds])

  useEffect(() => {
    if (activeSurface !== 'radio') return
    if (!selectedRadioStation && radioStations.length) {
      setSelectedRadioId(radioStations[0].id)
    }
  }, [activeSurface, selectedRadioStation])

  useEffect(() => {
    if (activeSurface !== 'cinema') return
    if (!selectedMovie && movies.length) {
      setSelectedMovieId(movies[0].id)
    }
  }, [activeSurface, movies, selectedMovie])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !selectedPlaybackChannel) return
    const media: HTMLMediaElement = video

    if (activeSurface === 'iptv' && media.dataset.initialMuteApplied !== 'true') {
      media.defaultMuted = true
      media.muted = true
      media.dataset.initialMuteApplied = 'true'
    } else if (activeSurface !== 'iptv') {
      media.defaultMuted = false
      media.muted = false
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
    if (dashRef.current) {
      void dashRef.current.reset()
      dashRef.current = null
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

    const onWaiting = () => setPlayerState(activeSurface === 'radio' && radioReplay ? 'Carregando replay...' : 'Aguardando buffer...')
    const onPlaying = () => setPlayerState(activeSurface === 'radio' ? radioPlaybackBadge : 'Ao vivo')
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
      setPlayerState((current) => (current === 'Ao vivo' || current === radioPlaybackBadge ? current : 'Stream pronta'))
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
      if (dashRef.current) {
        void dashRef.current.reset()
        dashRef.current = null
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
        source.engine === 'dash'
          ? sourceIndex === 0
            ? 'Abrindo DASH oficial...'
            : 'Tentando DASH novamente...'
          :
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
      }, source.engine === 'mpegts' ? 14000 : source.engine === 'dash' ? 16000 : 12000)

      if (source.engine === 'dash') {
        const imported = await import('shaka-player')
        const shakaModule = (imported as unknown as { default?: Record<string, unknown> })?.default ?? imported
        const shakaApi = shakaModule as {
          polyfill?: { installAll?: () => void }
          Player?: new () => {
            attach?: (mediaElement: HTMLMediaElement) => Promise<void>
            configure: (settings: Record<string, unknown>) => void
            addEventListener: (event: string, listener: (event: unknown) => void) => void
            load: (source: string) => Promise<void>
            destroy: () => Promise<void>
          }
        }

        shakaApi.polyfill?.installAll?.()

        if (!shakaApi.Player) {
          void trySource(sourceIndex + 1, 'DASH nao disponivel neste navegador.')
          return
        }

        const player = new shakaApi.Player()
        dashRef.current = { reset: () => player.destroy() }
        if (player.attach) {
          try {
            await player.attach(media)
          } catch (error) {
            const detail = error instanceof Error ? error.message : 'Falha ao acoplar o player DASH.'
            void trySource(sourceIndex + 1, detail)
            return
          }
        }
        player.configure({
          streaming: {
            lowLatencyMode: false,
            bufferingGoal: activeSurface === 'radio' ? 30 : 18,
            rebufferingGoal: activeSurface === 'radio' ? 8 : 4,
            bufferBehind: activeSurface === 'radio' ? 30 : 20,
            retryParameters: {
              maxAttempts: 5,
              baseDelay: 1000,
              backoffFactor: 2,
              fuzzFactor: 0.35,
              timeout: 20000,
            },
          },
          manifest: {
            dash: {
              ignoreMinBufferTime: true,
            },
          },
          abr: {
            enabled: true,
          },
        })

        player.addEventListener('error', (event) => {
          const payload = event as { detail?: { message?: string; severity?: number } } | undefined
          if (cancelled || successLocked) return
          void trySource(
            sourceIndex + 1,
            payload?.detail?.message || 'DASH recusado pela origem da stream.',
          )
        })

        try {
          await player.load(source.url)
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'DASH recusado pela origem da stream.'
          void trySource(sourceIndex + 1, detail)
          return
        }

        window.clearTimeout(fallbackTimer)
        successLocked = true
        const nextState = await attemptMediaPlayback(
          media,
          activeSurface === 'radio' && radioReplay ? 'Clique em play para iniciar o replay' : 'Clique em play para iniciar',
          { stabilizeRadio: activeSurface === 'radio' },
        )
        if (!cancelled) setPlayerState(nextState)
        return
      }

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
          backBufferLength: activeSurface === 'radio' ? 60 : 30,
          liveSyncDurationCount: activeSurface === 'radio' ? 6 : 4,
          liveMaxLatencyDurationCount: activeSurface === 'radio' ? 18 : 12,
          maxBufferLength: activeSurface === 'radio' ? 45 : 30,
          maxMaxBufferLength: activeSurface === 'radio' ? 90 : 60,
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
          const nextState = await attemptMediaPlayback(
            media,
            activeSurface === 'radio' && radioReplay ? 'Clique em play para iniciar o replay' : 'Clique em play para iniciar',
            { stabilizeRadio: activeSurface === 'radio' },
          )
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
        const nextState = await attemptMediaPlayback(
          media,
          activeSurface === 'radio' && radioReplay ? 'Clique em play para iniciar o replay' : 'Clique em play para iniciar',
          { stabilizeRadio: activeSurface === 'radio' },
        )
        if (!cancelled) setPlayerState(nextState)
        return
      }

      if (
        media.canPlayType('application/vnd.apple.mpegurl') ||
        media.canPlayType('video/mp2t') ||
        media.canPlayType('audio/mpeg') ||
        media.canPlayType('audio/mp4') ||
        media.canPlayType('audio/x-m4a')
      ) {
        media.src = source.url
        window.clearTimeout(fallbackTimer)
        successLocked = true
        const nextState = await attemptMediaPlayback(
          media,
          activeSurface === 'radio' && radioReplay ? 'Clique em play para iniciar o replay' : 'Clique em play para iniciar',
          { stabilizeRadio: activeSurface === 'radio' },
        )
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
  }, [activeSurface, radioPlaybackBadge, radioReplay, selectedPlaybackChannel?.id, selectedPlaybackChannel?.streamUrl])

  useEffect(() => {
    const video = videoRef.current

    if (!video || activeSurface !== 'radio') {
      setRadioSeekWindowSeconds(0)
      return
    }

    const updateSeekWindow = () => {
      if (!video.seekable.length) {
        setRadioSeekWindowSeconds(0)
        return
      }

      const index = video.seekable.length - 1
      const start = video.seekable.start(index)
      const end = video.seekable.end(index)

      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        setRadioSeekWindowSeconds(0)
        return
      }

      setRadioSeekWindowSeconds(Math.max(0, end - start))

    }

    updateSeekWindow()

    const interval = window.setInterval(updateSeekWindow, 15000)
    video.addEventListener('loadedmetadata', updateSeekWindow)
    video.addEventListener('durationchange', updateSeekWindow)
    video.addEventListener('progress', updateSeekWindow)
    video.addEventListener('seeked', updateSeekWindow)

    return () => {
      window.clearInterval(interval)
      video.removeEventListener('loadedmetadata', updateSeekWindow)
      video.removeEventListener('durationchange', updateSeekWindow)
      video.removeEventListener('progress', updateSeekWindow)
      video.removeEventListener('seeked', updateSeekWindow)
    }
  }, [activeSurface, radioReplay, selectedRadioStation?.id])

  useEffect(() => {
    if (activeSurface !== 'radio' || !selectedRadioStation || !canShowRadioGuide) {
      setRadioGuide(null)
      setRadioGuideError('')
      setRadioGuideState('idle')
      return
    }

    let cancelled = false

    const refreshGuide = async () => {
      if (!cancelled) {
        setRadioGuideState((current) => (current === 'ready' ? current : 'loading'))
        setRadioGuideError('')
      }

      try {
        const snapshot = await loadRadioGuide(selectedRadioStation, DEFAULT_XTREAM_PROXY_URL)
        if (cancelled) return
        setRadioGuide(snapshot)
        setRadioGuideState('ready')
      } catch (error) {
        if (cancelled) return
        setRadioGuide(null)
        setRadioGuideState('failed')
        setRadioGuideError(
          error instanceof Error
            ? error.message
            : 'Nao consegui ler a programacao oficial dessa radio agora.',
        )
      }
    }

    void refreshGuide()
    const interval = window.setInterval(refreshGuide, 5 * 60_000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [activeSurface, canShowRadioGuide, selectedRadioStation?.id])

  useEffect(() => {
    let isActive = true

    const refresh = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return
      }

      const nextStatus: Record<string, EmbedStatus> = {}
      const twitchChannels = Array.from(
        new Set(
          embeds
            .filter((item) => item.platform === 'twitch')
            .map((item) => item.channel.trim().toLowerCase())
            .filter(Boolean),
        ),
      )

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

      const youtubeChannels = Array.from(
        new Set(
          embeds
            .filter((item) => item.platform === 'youtube')
            .map((item) => item.channel.trim())
            .filter(Boolean),
        ),
      )

      if (youtubeChannels.length) {
        try {
          Object.assign(
            nextStatus,
            await fetchYoutubeStatuses(youtubeChannels, DEFAULT_XTREAM_PROXY_URL),
          )
        } catch (error) {
          const detail = error instanceof Error ? error.message : YOUTUBE_STATUS_HELP
          youtubeChannels.forEach((channel) => {
            nextStatus[channel.toLowerCase()] = {
              label: 'Erro',
              state: 'error',
              detail,
              updatedAt: new Date().toISOString(),
            }
          })
        }
      }

      const kickChannels = Array.from(
        new Set(
          embeds
            .filter((item) => item.platform === 'kick')
            .map((item) => item.channel.trim().toLowerCase())
            .filter(Boolean),
        ),
      )

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
            const statusKey = item.channel.toLowerCase()
            const currentStatus = nextStatus[statusKey]
            try {
              nextStatus[statusKey] = await fetchCustomStatus(item.statusEndpoint!.trim())
            } catch (error) {
              nextStatus[statusKey] = currentStatus || {
                label: 'Indisponivel',
                state: 'unknown',
                detail: error instanceof Error ? error.message : 'Falha ao consultar status externo.',
                updatedAt: new Date().toISOString(),
              }
            }
          }),
      )

      if (isActive) setStatusMap(nextStatus)
    }

    void refresh()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
    }

    const interval = window.setInterval(() => void refresh(), LIVE_STATUS_REFRESH_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      isActive = false
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [
    embeds,
    settings.kickAppAccessToken,
    settings.kickAppTokenExpiresAt,
    settings.kickClientId,
    settings.kickClientSecret,
    settings.twitchAccessToken,
    settings.twitchClientId,
  ])

  useEffect(() => {
    const destroyTwitchPlayer = () => {
      try {
        twitchPlayerRef.current?.pause?.()
      } catch {
        // Ignore pause failures while unmounting.
      }
      try {
        twitchPlayerRef.current?.destroy?.()
      } catch {
        // Ignore destroy failures while unmounting.
      }
      twitchPlayerRef.current = null
      if (twitchPlayerHostRef.current) {
        twitchPlayerHostRef.current.innerHTML = ''
      }
    }

    if (activeSurface !== 'twitch' || !activeEmbed || !twitchPlayerHostRef.current) {
      destroyTwitchPlayer()
      return
    }

    let cancelled = false
    setPlayerError('')
    setPlayerState('Abrindo Twitch...')

    const boot = async () => {
      try {
        await ensureTwitchPlayerScript()
        if (cancelled || !twitchPlayerHostRef.current || !window.Twitch?.Player) return

        destroyTwitchPlayer()

        const player = new window.Twitch.Player(twitchPlayerHostRef.current, {
          channel: activeEmbed.channel,
          parent: [window.location.hostname || 'localhost'],
          autoplay: true,
          muted: true,
          width: '100%',
          height: '100%',
        })

        twitchPlayerRef.current = player

        const startPlayback = () => {
          if (cancelled) return
          try {
            player.setMuted?.(true)
            player.setVolume?.(0)
            player.play?.()
          } catch {
            // Twitch player may reject play until ready; keep quiet and let the UI continue.
          }
          setPlayerState('Twitch ao vivo')
        }

        const readyEvent = window.Twitch.Embed?.VIDEO_READY || 'ready'
        player.addEventListener?.(readyEvent, startPlayback)
        window.setTimeout(startPlayback, 450)
      } catch (error) {
        if (!cancelled) {
          setPlayerError(error instanceof Error ? error.message : 'Falha ao abrir a Twitch agora.')
          setPlayerState('Falha ao abrir Twitch')
        }
      }
    }

    void boot()

    return () => {
      cancelled = true
      destroyTwitchPlayer()
    }
  }, [activeEmbed, activeSurface])

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
      setLoadError(formatXtreamError(error, nextCredentials))
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

    if (surface === 'youtube') {
      setSelectedEmbedId((current) => current && youtubeEmbeds.some((item) => item.id === current) ? current : (youtubeEmbeds[0]?.id ?? null))
      return
    }

    if (surface === 'kick') {
      setSelectedEmbedId((current) => current && kickEmbeds.some((item) => item.id === current) ? current : (kickEmbeds[0]?.id ?? null))
      return
    }

    if (surface === 'radio') {
      setSelectedRadioId((current) => current && radioStations.some((item) => item.id === current) ? current : (radioStations[0]?.id ?? ''))
      return
    }

    if (surface === 'cinema') {
      setSelectedMovieId((current) => current && movies.some((item) => item.id === current) ? current : (movies[0]?.id ?? null))
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
    setPlayerState(
      embed.platform === 'twitch'
        ? 'Twitch em foco'
        : embed.platform === 'youtube'
          ? 'YouTube em foco'
          : 'Kick em foco',
    )
  }

  function activateRadio(radioId?: string) {
    if (radioId) setSelectedRadioId(radioId)
    setRadioReplay(null)
    setSurface('radio')
    setPlayerError('')
    setPlayerState('Radio em foco')
  }

  async function seekRadioBack(secondsBack: number) {
    const video = videoRef.current
    setPlayerError('')

    if (video && video.seekable.length) {
      const rangeIndex = video.seekable.length - 1
      const start = video.seekable.start(rangeIndex)
      const end = video.seekable.end(rangeIndex)
      const availableWindow = Math.max(0, end - start)

      if (availableWindow >= secondsBack) {
        setRadioReplay(null)
        video.currentTime = Math.max(start, end - secondsBack)
        void video.play().catch(() => {})
        setPlayerState(`Replay ${formatWindowLabel(secondsBack)} atras`)
        return
      }
    }

    if (!selectedRadioStation) return

    if (selectedRadioStation.catchupMode === 'global' && selectedRadioStation.catchupIndexHref) {
      try {
        setPlayerState(`Buscando replay oficial ${formatWindowLabel(secondsBack)}...`)
        const replay = await resolveGlobalCatchupReplay(
          selectedRadioStation,
          secondsBack,
          DEFAULT_XTREAM_PROXY_URL,
        )
        setRadioReplay(replay)
        setPlayerState(`Replay ${formatWindowLabel(secondsBack)} atras`)
        return
      } catch (error) {
        setPlayerError(error instanceof Error ? error.message : 'Falha ao abrir o replay oficial agora.')
        setPlayerState('Falha no replay')
        return
      }
    }

    setPlayerError('Essa radio nao expoe rewind direto no feed atual. Use o catch up oficial quando estiver disponivel.')
  }

  function jumpRadioToLive() {
    if (radioReplay) {
      setRadioReplay(null)
      setPlayerError('')
      setPlayerState('Voltando ao vivo...')
      return
    }

    const video = videoRef.current
    if (!video || !video.seekable.length) return

    const rangeIndex = video.seekable.length - 1
    const end = video.seekable.end(rangeIndex)
    video.currentTime = Math.max(0, end - 2)
    void video.play().catch(() => {})
    setPlayerState('Voltando ao vivo...')
  }

  async function addEmbed() {
    const rawChannel = embedDraft.channel.trim()
    if (!rawChannel) return

    let normalizedChannel = rawChannel
    if (embedDraft.platform === 'youtube') {
      try {
        normalizedChannel = await resolveYoutubeChannelInput(rawChannel, DEFAULT_XTREAM_PROXY_URL)
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : 'Nao consegui entender esse link do YouTube.')
        return
      }
    }

    const nextEmbed = {
      id: crypto.randomUUID(),
      platform: embedDraft.platform,
      channel: normalizedChannel,
      title: embedDraft.title.trim() || `${embedDraft.platform} / ${normalizedChannel}`,
      statusEndpoint: embedDraft.statusEndpoint?.trim() || undefined,
    }
    setEmbeds((current) => [
      nextEmbed,
      ...current,
    ])
    setSelectedEmbedId(nextEmbed.id)
    setActiveSurface(nextEmbed.platform)
    setEmbedDraft({ id: '', platform: 'twitch', channel: '', title: '', statusEndpoint: '' })
    setLoadError('')
  }

  function addMovie() {
    const driveUrl = movieDraft.driveUrl.trim()
    const previewUrl = buildDrivePreviewUrl(driveUrl)
    if (!driveUrl || !previewUrl) {
      setLoadError('Cole um link compartilhado de arquivo do Google Drive para adicionar em Cinema.')
      return
    }

    const nextMovie: MovieItem = {
      id: crypto.randomUUID(),
      title: movieDraft.title.trim() || 'Filme no Drive',
      driveUrl,
      previewUrl,
      openUrl: buildDriveOpenUrl(driveUrl),
    }

    setMovies((current) => [nextMovie, ...current])
    setSelectedMovieId(nextMovie.id)
    setSurface('cinema')
    setMovieDraft({ title: '', driveUrl: '' })
    setLoadError('')
  }

  function toggleFavorite(channelId: string) {
    setFavorites((current) => (current.includes(channelId) ? current.filter((id) => id !== channelId) : [channelId, ...current]))
  }

  function removeEmbed(embedId: string) {
    setEmbeds((current) => current.filter((entry) => entry.id !== embedId))

    if (selectedEmbedId === embedId) {
      const nextTwitch = twitchEmbeds.find((entry) => entry.id !== embedId)
      const nextYouTube = youtubeEmbeds.find((entry) => entry.id !== embedId)
      const nextKick = kickEmbeds.find((entry) => entry.id !== embedId)

      if (activeSurface === 'twitch' && nextTwitch) {
        setSelectedEmbedId(nextTwitch.id)
      } else if (activeSurface === 'youtube' && nextYouTube) {
        setSelectedEmbedId(nextYouTube.id)
      } else if (activeSurface === 'kick' && nextKick) {
        setSelectedEmbedId(nextKick.id)
      } else {
        setSelectedEmbedId(null)
        setActiveSurface('iptv')
      }
    }
  }

  function removeMovie(movieId: string) {
    const nextMovie = movies.find((item) => item.id !== movieId) || null
    setMovies((current) => current.filter((item) => item.id !== movieId))

    if (selectedMovieId === movieId) {
      setSelectedMovieId(nextMovie?.id || null)
      if (!nextMovie) {
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

  function exportSiteBundle() {
    const payload: SiteTransferBundle = {
      version: 1,
      sourceTab,
      xtream,
      m3u,
      settings,
      embeds,
      favorites,
      activeSurface,
      selectedEmbedId,
      selectedRadioId,
      movies,
      selectedMovieId,
      showLiveNowPanel,
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = 'iptv-pages-hub-site-backup.json'
    link.click()
    URL.revokeObjectURL(objectUrl)
    setLoadError('')
    setTransferMessage('Backup completo do site exportado. Esse arquivo leva APIs, feeds, favoritos e preferencias para outro PC.')
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

  async function importSiteBundle(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    try {
      const rawText = await file.text()
      const payload = JSON.parse(rawText) as Partial<SiteTransferBundle>
      const nextSourceTab = payload.sourceTab === 'm3u' ? 'm3u' : 'xtream'
      const nextXtream = withDefaultProxy(payload.xtream ? payload.xtream as XtreamCredentials : defaultXtream)
      const nextM3U = mergeM3U(payload.m3u)
        const nextSettings = mergeSettings(payload.settings)
        const nextEmbeds = normalizeEmbeds(payload.embeds)
        const nextMovies = normalizeMovies(payload.movies)
        const nextFavorites = Array.isArray(payload.favorites)
          ? payload.favorites.map((item) => String(item || '').trim()).filter(Boolean)
          : []
        const nextActiveSurface = payload.activeSurface === 'twitch'
          || payload.activeSurface === 'youtube'
          || payload.activeSurface === 'kick'
          || payload.activeSurface === 'news'
          || payload.activeSurface === 'radio'
          || payload.activeSurface === 'cinema'
          || payload.activeSurface === 'iptv'
          ? payload.activeSurface
          : 'iptv'
        const nextSelectedEmbedId = payload.selectedEmbedId ? String(payload.selectedEmbedId) : null
        const nextSelectedRadioId = payload.selectedRadioId && radioStations.some((item) => item.id === payload.selectedRadioId)
          ? payload.selectedRadioId
          : (radioStations[0]?.id || '')
        const nextSelectedMovieId = payload.selectedMovieId && nextMovies.some((item) => item.id === payload.selectedMovieId)
          ? payload.selectedMovieId
          : (nextMovies[0]?.id || null)
        const nextShowLiveNowPanel = Boolean(payload.showLiveNowPanel)

        setSourceTab(nextSourceTab)
        setXtream(nextXtream)
        setM3U(nextM3U)
        setSettings(nextSettings)
        setEmbeds(nextEmbeds)
        setMovies(nextMovies)
        setFavorites(nextFavorites)
        setActiveSurface(nextActiveSurface)
        setSelectedEmbedId(nextSelectedEmbedId)
        setSelectedRadioId(nextSelectedRadioId)
        setSelectedMovieId(nextSelectedMovieId)
        setShowLiveNowPanel(nextShowLiveNowPanel)

      saveJson<PersistedFormState>(FORM_STATE_KEY, {
        sourceTab: nextSourceTab,
        xtream: nextXtream,
        m3u: nextM3U,
      })
      saveJson<AppSettings>(SETTINGS_KEY, nextSettings)
      saveJson<EmbedStream[]>(EMBEDS_KEY, nextEmbeds)
      saveJson<MovieItem[]>(MOVIES_KEY, nextMovies)
      saveJson<string[]>(FAVORITES_KEY, nextFavorites)
      saveJson<MediaSurface>(ACTIVE_SURFACE_KEY, nextActiveSurface)
      saveJson<boolean>(SHOW_LIVE_NOW_KEY, nextShowLiveNowPanel)
      saveJson<PersistedConnection>(CONNECTION_KEY, {
        kind: nextSourceTab,
        remember: nextSettings.rememberConnection,
        xtream: nextXtream,
        m3u: nextM3U,
      })

      if (nextSelectedEmbedId) {
        window.localStorage.setItem(SELECTED_EMBED_KEY, nextSelectedEmbedId)
      } else {
        window.localStorage.removeItem(SELECTED_EMBED_KEY)
      }

      if (nextSelectedRadioId) {
        window.localStorage.setItem(SELECTED_RADIO_KEY, nextSelectedRadioId)
      }

      if (nextSelectedMovieId) {
        window.localStorage.setItem(SELECTED_MOVIE_KEY, nextSelectedMovieId)
      } else {
        window.localStorage.removeItem(SELECTED_MOVIE_KEY)
      }

      setLoadError('')
      setTransferMessage('Backup completo importado. APIs, feeds, favoritos e preferencias ja ficaram salvos neste navegador.')
    } catch {
      setTransferMessage('')
      setLoadError('Nao consegui importar esse backup completo. Use um arquivo gerado pelo botao Exportar site.')
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
            <p class="hero-subcopy">Horario no Brasil, em Londres, em Chicago, em Paris, em LA e em NY no topo. IPTV, noticias e agora radios entram no mesmo palco leve para manter a navegacao agil.</p>
            <LiveDashboardMeta />
          </div>
            <div class="surface-switch hero-surface-switch">
              <button class={activeSurface === 'iptv' ? 'active' : ''} type="button" onClick={() => setSurface('iptv')}>IPTV</button>
              <button class={activeSurface === 'twitch' ? 'active' : ''} disabled={!twitchEmbeds.length} type="button" onClick={() => setSurface('twitch')}>Twitch</button>
              <button class={activeSurface === 'youtube' ? 'active youtube-tab' : 'youtube-tab'} disabled={!youtubeEmbeds.length} type="button" onClick={() => setSurface('youtube')}>YouTube</button>
              <button class={activeSurface === 'kick' ? 'active' : ''} disabled={!kickEmbeds.length} type="button" onClick={() => setSurface('kick')}>Kick</button>
              <button class={activeSurface === 'news' ? 'active' : ''} type="button" onClick={() => setSurface('news')}>Noticias</button>
              <button class={activeSurface === 'radio' ? 'active' : ''} type="button" onClick={() => setSurface('radio')}>Radios</button>
              <button class={activeSurface === 'cinema' ? 'active cinema-tab' : 'cinema-tab'} type="button" onClick={() => setSurface('cinema')}>Cinema</button>
            </div>
      </header>

      <div class="feed-strip-shell news-shortcuts-shell">
        <button aria-label="Ver canais anteriores" class="feed-strip-nav" disabled={!newsShortcutLeftReady} type="button" onClick={() => scrollNewsShortcut('left')}>
          <span aria-hidden="true">‹</span>
        </button>
        <div class="news-shortcuts feed-strip-scroll" ref={newsShortcutRef}>
          {orderedNewsLinks.map((item) => (
              <button class={activeSurface === 'news' && selectedNewsLink.id === item.id ? 'feed-pill news-feed-pill active button-pill' : 'feed-pill news-feed-pill button-pill'} key={item.id} type="button" onClick={() => { setSelectedNewsId(item.id); setSurface('news') }}>
              <span>{item.name}</span>
              <strong>{item.streamUrl || item.embedUrl ? 'PLAY' : 'LINK'}</strong>
            </button>
          ))}
        </div>
        <button aria-label="Ver mais canais" class="feed-strip-nav" disabled={!newsShortcutRightReady} type="button" onClick={() => scrollNewsShortcut('right')}>
          <span aria-hidden="true">›</span>
        </button>
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
                      <div class="button-row"><button class="ghost-button" type="button" onClick={exportSiteBundle}>Exportar site</button><button class="ghost-button" type="button" onClick={() => siteBackupInputRef.current?.click()}>Importar site</button><input ref={siteBackupInputRef} accept=".json,application/json" class="hidden-input" type="file" onChange={importSiteBundle} /></div>
                      {transferMessage ? <p class="helper-copy">{transferMessage}</p> : null}
                    </div>
                  {loadError ? <p class="alert error">{loadError}</p> : null}
                </div>
              ) : null}
            </div>

            <div class={activeSurface === 'iptv' ? 'sidebar-section active' : 'sidebar-section'}>
              <button class={showIptvPanel ? 'section-toggle active' : 'section-toggle'} type="button" onClick={() => setShowIptvPanel((current) => !current)}>
                <span>Lista IPTV</span>
                <small>{PT_BR_NUMBER.format(visibleChannels.length)} canais</small>
              </button>
              {showIptvPanel ? (
                <div class="sidebar-content stack">
                  <div class="field-grid compact sidebar-filters">
                    <label><span>Buscar</span><input placeholder="Nome, grupo ou EPG" value={searchTerm} onInput={(event) => setSearchTerm((event.currentTarget as HTMLInputElement).value)} /></label>
                    <label class="group-field"><span>Grupo</span><select class="group-select" value={groupFilter} onChange={(event) => setGroupFilter((event.currentTarget as HTMLSelectElement).value)}><option value="Todos">Todos</option>{(playlist?.groups ?? []).map((group) => <option key={group} value={group}>{group}</option>)}</select></label>
                  </div>
                  <div class="group-summary"><span class="pill active-group">{groupFilter}</span><span class="helper-copy">{playlist?.groups.length || 0} grupos</span></div>
                  <div class="sidebar-list">
                    {displayedChannels.length ? displayedChannels.map((channel) => {
                      const isFavorite = favorites.includes(channel.id)
                      const isActive = channel.id === selectedChannel?.id

                      return (
                        <div
                          aria-pressed={isActive}
                          class={isActive ? 'list-row active' : 'list-row'}
                          key={channel.id}
                          onClick={() => activateIPTV(channel.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              activateIPTV(channel.id)
                            }
                          }}
                          role="button"
                          tabIndex={0}
                        >
                          <div class="list-row-art">{channel.logo ? <img alt={channel.name} loading="lazy" src={channel.logo} /> : <span>{channel.name.slice(0, 2).toUpperCase()}</span>}</div>
                          <div class="list-row-copy"><strong>{channel.name}</strong><span>{channel.group}</span></div>
                          <button
                            aria-label={isFavorite ? `Remover ${channel.name} dos favoritos` : `Salvar ${channel.name} nos favoritos`}
                            class={isFavorite ? 'favorite-button active' : 'favorite-button'}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleFavorite(channel.id)
                            }}
                          >
                            {isFavorite ? 'Salvo' : 'Fav'}
                          </button>
                        </div>
                      )
                    }) : <div class="empty-state compact-empty"><strong>Nenhum canal encontrado.</strong><span>Ajuste os filtros ou conecte uma playlist.</span></div>}
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

            <div class={activeSurface === 'youtube' ? 'sidebar-section active' : 'sidebar-section'}>
              <button class={showYouTubePanel ? 'section-toggle active' : 'section-toggle'} disabled={!youtubeEmbeds.length} type="button" onClick={() => setShowYouTubePanel((current) => !current)}>
                <span>Feeds YouTube</span>
                <small>{onlineYouTubeCount} ao vivo - {youtubeEmbeds.length} total</small>
              </button>
              {showYouTubePanel ? <div class="sidebar-content"><div class="sidebar-list">{sortedYouTubeEmbeds.length ? sortedYouTubeEmbeds.map((item) => { const status = statusMap[item.channel.toLowerCase()]; return <button key={item.id} class={activeEmbed?.id === item.id ? 'list-row active media-row' : 'list-row media-row'} type="button" onClick={() => activateEmbed(item)}><div class="list-row-copy"><strong>{item.title}</strong><span>{item.channel}</span></div><span class={statusTone(status?.state || 'unknown', 'youtube')}>{status?.label || 'Aguardando'}</span></button> }) : <div class="empty-state compact-empty"><strong>Nenhum feed do YouTube cadastrado.</strong><span>Adicione um canal no painel da direita.</span></div>}</div></div> : null}
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
              {showNewsPanel ? <div class="sidebar-content"><div class="sidebar-list">{orderedNewsLinks.map((item) => <button key={item.id} class={selectedNewsLink.id === item.id ? 'list-row active media-row' : 'list-row media-row'} type="button" onClick={() => setSelectedNewsId(item.id)}><div class="list-row-copy"><strong>{item.name}</strong><span>{item.source}</span></div><span class="status-chip unknown">Link</span></button>)}</div></div> : null}
            </div>

            <div class={activeSurface === 'radio' ? 'sidebar-section active' : 'sidebar-section'}>
              <button class={showRadioPanel ? 'section-toggle active' : 'section-toggle'} type="button" onClick={() => setShowRadioPanel((current) => !current)}>
                <span>Radios</span>
                <small>{radioStations.length} emissoras</small>
              </button>
              {showRadioPanel ? (
                <div class="sidebar-content stack">
                  <div class="group-summary">
                    <span class="pill active-group">{selectedRadioStation?.source || 'Ao vivo'}</span>
                    <span class="helper-copy">{Object.keys(radioCategoryCounts).length} grupos</span>
                  </div>
                  <div class="sidebar-list">
                    {radioStations.map((item) => (
                      <button key={item.id} class={selectedRadioStation?.id === item.id ? 'list-row active media-row' : 'list-row media-row'} type="button" onClick={() => activateRadio(item.id)}>
                        <div class="list-row-art">{item.logo ? <img alt={item.name} loading="lazy" src={item.logo} /> : <span>{item.name.slice(0, 2).toUpperCase()}</span>}</div>
                        <div class="list-row-copy">
                          <strong>{item.name}</strong>
                          <span>{item.category} · {item.source}</span>
                        </div>
                        <span class="status-chip unknown">{item.rewindHours ? `${item.rewindHours}h` : 'Live'}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div class={activeSurface === 'cinema' ? 'sidebar-section active' : 'sidebar-section'}>
              <button class={showCinemaPanel ? 'section-toggle active' : 'section-toggle'} type="button" onClick={() => setShowCinemaPanel((current) => !current)}>
                <span>Cinema</span>
                <small>{movies.length} filmes</small>
              </button>
              {showCinemaPanel ? <div class="sidebar-content"><div class="sidebar-list">{movies.length ? movies.map((item) => <button key={item.id} class={selectedMovie?.id === item.id ? 'list-row active media-row' : 'list-row media-row'} type="button" onClick={() => { setSelectedMovieId(item.id); setSurface('cinema') }}><div class="list-row-copy"><strong>{item.title}</strong><span>Google Drive preview</span></div><span class="status-chip unknown">Drive</span></button>) : <div class="empty-state compact-empty"><strong>Nenhum filme cadastrado.</strong><span>Cole um link compartilhado do Drive no painel da direita.</span></div>}</div></div> : null}
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
                {orderedNewsLinks.map((item) => (
                  <button class={selectedNewsLink.id === item.id ? 'feed-pill news-feed-pill active button-pill' : 'feed-pill news-feed-pill button-pill'} key={item.id} type="button" onClick={() => setSelectedNewsId(item.id)}>
                    <span>{item.name}</span>
                    <strong>LIVE</strong>
                  </button>
                ))}
              </div>
              <button aria-label="Ver mais canais" class="feed-strip-nav" disabled={!newsStripRightReady} type="button" onClick={() => scrollNewsStrip('right')}>
                <span aria-hidden="true">›</span>
              </button>
            </div>
          ) : activeSurface === 'twitch' || activeSurface === 'youtube' || activeSurface === 'kick' ? (
            <div class="feed-strip-shell stage-feed-strip">
              <button aria-label="Ver feeds anteriores" class="feed-strip-nav" disabled={!mediaStripLeftReady} type="button" onClick={() => scrollMediaStrip('left')}>
                <span aria-hidden="true">&lsaquo;</span>
              </button>
              <div class="feed-strip stage-feed-strip media-stage-strip feed-strip-scroll" ref={mediaStripRef}>
                {activeFeedItems.map((item) => {
                  const status = statusMap[item.channel.toLowerCase()]
                  return (
                    <button class={feedPillTone(item.platform, activeEmbed?.id === item.id)} key={item.id} type="button" onClick={() => activateEmbed(item)}>
                      <span>{item.channel}</span>
                      <strong>{status?.label || 'OFF'}</strong>
                    </button>
                  )
                })}
              </div>
              <button aria-label="Ver mais feeds" class="feed-strip-nav" disabled={!mediaStripRightReady} type="button" onClick={() => scrollMediaStrip('right')}>
                <span aria-hidden="true">&rsaquo;</span>
              </button>
            </div>
          ) : (
            <div class="feed-strip stage-feed-strip">
              {activeSurface === 'iptv' ? (
                <>
                  <span class="feed-pill active">{groupFilter}</span>
                  <span class="feed-pill">{favorites.length} favoritos</span>
                  <span class="feed-pill">{PT_BR_NUMBER.format(visibleChannels.length)} visiveis</span>
                  <span class="feed-pill soft">{playerState}</span>
                </>
              ) : activeSurface === 'radio' ? (
                <>
                  <span class="feed-pill active">{selectedRadioStation?.source || 'Radio'}</span>
                  <span class="feed-pill">{radioStations.length} radios</span>
                  <span class="feed-pill">{selectedRadioStation?.category || 'Ao vivo'}</span>
                  <span class="feed-pill soft">{radioPlaybackBadge}</span>
                </>
              ) : activeSurface === 'cinema' ? (
                <>
                  <span class="feed-pill active cinema-pill">Cinema</span>
                  <span class="feed-pill">{movies.length} filmes</span>
                  <span class="feed-pill soft">{selectedMovie?.title || 'Selecione um filme'}</span>
                </>
                ) : (
                  null
                )}
              </div>
            )}

          {activeSurface === 'iptv' ? (
            <>
              <div class="panel-heading">
                <div><p class="section-tag">IPTV ao vivo</p><h2>{selectedChannel?.name || 'Selecione um canal'}</h2></div>
                <div class="pill-row">{selectedChannel ? <button class={favorites.includes(selectedChannel.id) ? 'favorite-pill active' : 'favorite-pill'} type="button" onClick={() => toggleFavorite(selectedChannel.id)}>{favorites.includes(selectedChannel.id) ? 'Favorito' : 'Favoritar'}</button> : null}<span class="pill">{selectedChannel?.group || 'Sem grupo'}</span></div>
              </div>
              <div class="player-frame"><video autoPlay controls playsInline preload="auto" ref={(node) => { videoRef.current = node }} /></div>
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
                  <div class="player-frame"><video autoPlay controls playsInline preload="auto" ref={(node) => { videoRef.current = node }} /></div>
                  <div class="player-meta">
                    <div class="subtle-card compact-card"><p class="section-tag">Canal</p><h3>{selectedNewsLink.name}</h3><p class="helper-copy">{selectedNewsLink.note}</p></div>
                    <div class="subtle-card compact-card"><p class="section-tag">Status</p><h3>{playerState}</h3><p class="helper-copy">Feed de noticias rodando no mesmo player leve usado no site, via HLS/DASH oficial quando disponivel.</p></div>
                  </div>
                  {playerError ? <p class="alert error">{playerError}</p> : null}
                </>
              ) : newsMirrorState === 'resolving' ? (
                <div class="subtle-card compact-card news-stage-card">
                  <h3>Preparando {selectedNewsLink.name}</h3>
                  <p class="helper-copy">Resolvendo o feed leve desse canal para evitar o iframe pesado e abrir mais rapido no palco.</p>
                </div>
              ) : selectedNewsEmbedUrl ? (
                <>
                  <div class="player-frame embed-stage-frame news-embed-frame"><iframe allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowFullScreen loading="lazy" src={selectedNewsEmbedUrl} title={selectedNewsLink.name} /></div>
                  <div class="player-meta">
                    <div class="subtle-card compact-card"><p class="section-tag">Canal</p><h3>{selectedNewsLink.name}</h3><p class="helper-copy">{selectedNewsLink.note}</p></div>
                    <div class="subtle-card compact-card"><p class="section-tag">Origem</p><h3>{selectedNewsLink.source}</h3><p class="helper-copy">{newsMirrorError || 'Se o embed for bloqueado pela emissora ou pela sua regiao, use o botao para abrir a transmissao original.'}</p></div>
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
          ) : activeSurface === 'radio' && selectedRadioStation ? (
            <>
              <div class="panel-heading">
                <div>
                  <p class="section-tag">Radios ao vivo</p>
                  <h2>{selectedRadioStation.name}</h2>
                </div>
                <div class="pill-row">
                  <span class="pill">{selectedRadioStation.source}</span>
                  <span class="pill">{radioPlaybackBadge}</span>
                  <a class="ghost-button compact" href={selectedRadioStation.href} rel="noreferrer" target="_blank">Abrir oficial</a>
                </div>
              </div>
              <div class="player-frame radio-player-frame">
                <div class={radioReplay ? 'radio-playback-badge replay' : 'radio-playback-badge live'}>
                  <strong>{radioPlaybackBadge}</strong>
                  <span>{radioPlaybackDetail}</span>
                </div>
                <div class="radio-stage-visual">
                  <div class="radio-stage-logo">
                    <img alt={selectedRadioStation.name} loading="lazy" src={selectedRadioStation.logo} />
                  </div>
                  <div class="radio-stage-copy">
                    <p class="section-tag">Radio no palco</p>
                    <h3>{selectedRadioStation.name}</h3>
                    <p class="helper-copy">
                      {radioReplay
                        ? `Replay oficial carregado: ${radioReplay.title}.`
                        : selectedRadioStation.note}
                    </p>
                  </div>
                </div>
                <video autoPlay controls playsInline preload="auto" ref={(node) => { videoRef.current = node }} />
              </div>
              <div class="player-meta">
                <div class="subtle-card compact-card radio-summary-card">
                  <div class="radio-summary-head">
                    <div class="radio-summary-logo">
                      <img alt={selectedRadioStation.name} loading="lazy" src={selectedRadioStation.logo} />
                    </div>
                    <div>
                      <p class="section-tag">Fonte</p>
                      <h3>{selectedRadioStation.name}</h3>
                      <p class="helper-copy">{selectedRadioStation.note}</p>
                    </div>
                  </div>
                </div>
                <div class="subtle-card compact-card">
                  <p class="section-tag">Rewind</p>
                  <h3>{radioWindowLabel ? `Janela disponivel ${radioWindowLabel}` : 'Ao vivo direto'}</h3>
                  <p class="helper-copy">
                    {radioReplay
                      ? `${radioReplay.title} entrou pelo catch up oficial de ${radioReplay.source || selectedRadioStation.source}.`
                      : selectedRadioStation.rewindHours
                        ? 'As radios da BBC entram em DASH oficial com janela longa. Quando a live nao expuser isso, o catch up oficial entra como fallback.'
                        : selectedRadioStation.catchupHref
                          ? 'Se a live nao expuser a janela de rewind, o site abre automaticamente o replay oficial quando voce clicar em voltar.'
                          : 'Essa radio esta em live oficial. Se quiser ouvir programas anteriores, use o link de catch-up oficial.'}
                  </p>
                </div>
              </div>
              <div class="subtle-card radio-rewind-panel">
                <div class="panel-heading">
                  <div>
                    <p class="section-tag">Controles rapidos</p>
                    <h3>Recuar sem sair do palco</h3>
                  </div>
                  {selectedRadioStation.catchupHref ? (
                    <a class="ghost-button compact" href={selectedRadioStation.catchupHref} rel="noreferrer" target="_blank">
                      Catch Up oficial
                    </a>
                  ) : null}
                </div>
                <div class="rewind-grid">
                  {[900, 1800, 3600, 7200, 10800, 21600].map((seconds) => (
                    <button
                      class="ghost-button compact"
                      disabled={radioSeekWindowSeconds < seconds && selectedRadioStation.catchupMode !== 'global'}
                      key={seconds}
                      type="button"
                      onClick={() => seekRadioBack(seconds)}
                    >
                      -{formatWindowLabel(seconds)}
                    </button>
                  ))}
                  <button class="primary-button rewind-live-button" type="button" onClick={jumpRadioToLive}>
                    Ao vivo
                  </button>
                </div>
                {!radioSeekWindowSeconds ? (
                  <p class="helper-copy">
                    {selectedRadioStation.catchupMode === 'global'
                      ? 'Essa radio nao expoe rewind direto na live. Quando voce clicar em voltar, o player troca para o replay oficial da propria emissora.'
                      : 'Esse feed nao expoe rewind direto no manifesto. Quando isso acontecer, use o link oficial de catch up.'}
                  </p>
                ) : null}
              </div>
              {playerError ? <p class="alert error">{playerError}</p> : null}
            </>
          ) : activeSurface === 'cinema' && selectedMovie ? (
            <>
              <div class="panel-heading">
                <div><p class="section-tag">Cinema</p><h2>{selectedMovie.title}</h2></div>
                <div class="pill-row"><span class="pill">Google Drive</span><a class="ghost-button compact" href={selectedMovie.openUrl} rel="noreferrer" target="_blank">Abrir no Drive</a></div>
              </div>
              <div class="player-frame embed-stage-frame news-embed-frame"><iframe allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowFullScreen loading="lazy" src={selectedMovie.previewUrl} title={selectedMovie.title} /></div>
              <div class="player-meta">
                <div class="subtle-card compact-card"><p class="section-tag">Preview</p><h3>Drive em modo preview</h3><p class="helper-copy">O site tenta abrir o video direto no preview do Google Drive. Se o preview do Drive nao ficar bom, use o botao para abrir no Google Drive.</p></div>
                <div class="subtle-card compact-card"><p class="section-tag">Legendas</p><h3>Dependem do Drive</h3><p class="helper-copy">Neste modo o player e o do proprio Google Drive, entao legenda e PiP dependem do preview deles.</p></div>
              </div>
            </>
          ) : activeEmbed ? (
            <>
              <div class="panel-heading">
                <div><p class="section-tag">{activeSurface === 'twitch' ? 'Twitch' : activeSurface === 'youtube' ? 'YouTube' : 'Kick'}</p><h2>{activeEmbed.title}</h2></div>
                <div class="pill-row"><span class={statusTone(statusMap[activeEmbed.channel.toLowerCase()]?.state || 'unknown', activeSurface === 'kick' ? 'kick' : activeSurface === 'youtube' ? 'youtube' : 'twitch')}>{statusMap[activeEmbed.channel.toLowerCase()]?.label || 'Aguardando'}</span><a class="ghost-button compact" href={activeSurface === 'twitch' ? `https://twitch.tv/${activeEmbed.channel}` : activeSurface === 'youtube' ? (statusMap[activeEmbed.channel.toLowerCase()]?.watchUrl || `https://www.youtube.com/${activeEmbed.channel.startsWith('@') ? activeEmbed.channel : `@${activeEmbed.channel}`}`) : `https://kick.com/${activeEmbed.channel}`} rel="noreferrer" target="_blank">Abrir original</a></div>
              </div>
              <div class="player-frame embed-stage-frame">
                {activeSurface === 'twitch'
                  ? <div class="twitch-player-host" ref={twitchPlayerHostRef} />
                  : activeSurface === 'youtube'
                    ? statusMap[activeEmbed.channel.toLowerCase()]?.playbackUrl
                      ? <iframe allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowFullScreen loading="lazy" src={withAutoplayEmbedUrl(statusMap[activeEmbed.channel.toLowerCase()]?.playbackUrl)} title={activeEmbed.title} />
                      : <div class="empty-stage"><strong>Canal sem live agora.</strong><span>Quando o YouTube detectar uma live ativa nesse canal, ela abre aqui no palco.</span></div>
                    : <iframe allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowFullScreen loading="lazy" src={withAutoplayEmbedUrl(buildKickEmbedUrl(activeEmbed.channel))} title={activeEmbed.title} />}
              </div>
              <div class="player-meta">
                <div class="subtle-card compact-card"><p class="section-tag">Canal</p><h3>{activeEmbed.channel}</h3><p class="helper-copy">{statusMap[activeEmbed.channel.toLowerCase()]?.detail || 'Feed ativo no palco principal.'}</p></div>
                <div class="subtle-card compact-card"><p class="section-tag">Playback</p><h3>{activeSurface === 'youtube' ? 'Live oficial do YouTube' : 'Autoplay com mute inicial'}</h3><p class="helper-copy">{activeSurface === 'youtube' ? 'O app verifica a pagina /live do canal e, quando encontrar live ao vivo, abre o video direto no palco.' : 'Ao clicar no feed, o embed ja entra tocando. O mute inicial ajuda o navegador a liberar autoplay sem travar o palco.'}</p></div>
              </div>
            </>
          ) : <div class="empty-stage"><strong>Nenhum feed selecionado.</strong><span>Escolha um canal ou feed na sidebar.</span></div>}
        </section>

        {activeSurface === 'radio' && selectedRadioStation ? (
          <section class="panel manager-panel radio-side-panel">
            <div class="panel-heading">
              <div><p class="section-tag">Biblioteca de radios</p><h2>{selectedRadioStation.name}</h2></div>
              <span class="pill">{selectedRadioStation.source}</span>
            </div>
            <div class="feed-chip-grid">
                <article class="feed-chip-card">
                  <div>
                    <p class="section-tag">Categoria</p>
                    <h3>{selectedRadioStation.category}</h3>
                    <p class="helper-copy">{selectedRadioStation.note}</p>
                  </div>
                  <div class="feed-chip-actions">
                    <a class="ghost-button compact" href={selectedRadioStation.href} rel="noreferrer" target="_blank">BBC/Global oficial</a>
                    {selectedRadioStation.scheduleHref ? <a class="ghost-button compact" href={selectedRadioStation.scheduleHref} rel="noreferrer" target="_blank">{selectedRadioStation.scheduleLabel || 'Abrir grade'}</a> : null}
                    {selectedRadioStation.catchupHref ? <a class="ghost-button compact" href={selectedRadioStation.catchupHref} rel="noreferrer" target="_blank">Abrir catch up</a> : null}
                  </div>
                </article>
                {canShowRadioGuide ? (
                  <article class="feed-chip-card radio-guide-card">
                  <div>
                    <p class="section-tag">No ar agora</p>
                    <h3>{radioGuide?.now?.title || (radioGuideState === 'loading' ? 'Carregando grade...' : 'Grade indisponivel agora')}</h3>
                    <p class="helper-copy">
                      {radioGuide?.now?.subtitle
                        || radioGuide?.now?.description
                        || (radioGuideState === 'loading'
                          ? 'Lendo a fonte oficial dessa emissora.'
                          : radioGuideError || 'Nao consegui puxar a programacao oficial agora.')}
                    </p>
                    </div>
                    <div class="feed-chip-actions">
                      {radioGuide?.now?.timeLabel ? <span class="pill">{radioGuide.now.timeLabel}</span> : null}
                      {radioGuideUpdatedLabel ? <span class="pill soft">Atualizado {radioGuideUpdatedLabel} UK</span> : null}
                      {!radioGuide?.now && radioGuideState === 'failed' && selectedRadioScheduleHref ? <a class="ghost-button compact" href={selectedRadioScheduleHref} rel="noreferrer" target="_blank">{selectedRadioStation?.scheduleLabel || 'Ver grade oficial'}</a> : null}
                    </div>
                  </article>
                ) : null}
              <article class="feed-chip-card">
                <div>
                  <p class="section-tag">Rewind no palco</p>
                  <h3>{selectedRadioStation.rewindHours ? `Ate ${selectedRadioStation.rewindHours}h` : 'Live direto'}</h3>
                  <p class="helper-copy">
                    {selectedRadioStation.rewindHours
                      ? 'Quando a BBC expor a janela ao vivo no manifesto, o palco deixa recuar varias horas sem sair do site.'
                      : 'LBC e Radio X ficam no live oficial leve e usam Catch Up oficial para voltar em programas anteriores.'}
                  </p>
                </div>
                <div class="feed-chip-actions">
                  <span class="pill">{radioPlaybackBadge}</span>
                  {radioWindowLabel ? <span class="pill">Janela {radioWindowLabel}</span> : null}
                </div>
              </article>
              {canShowRadioGuide ? (
                <article class="feed-chip-card radio-guide-card">
                  <div>
                    <p class="section-tag">Programacao do dia</p>
                    <h3>{radioGuide?.providerLabel || 'Fonte oficial'}</h3>
                    <p class="helper-copy">
                      {radioGuide?.upcoming.length
                        ? 'Grade discreta, puxada so quando essa radio esta aberta.'
                        : radioGuideState === 'loading'
                          ? 'Montando os proximos programas oficiais.'
                          : 'A fonte oficial nao entregou a grade completa agora.'}
                    </p>
                  </div>
                  {radioGuide?.upcoming.length ? (
                    <div class="radio-guide-list">
                      {radioGuide.upcoming.slice(0, 4).map((entry) => (
                        <div class="radio-guide-row" key={`${entry.timeLabel}-${entry.title}`}>
                          <strong>{entry.timeLabel}</strong>
                          <span>{entry.title}</span>
                        </div>
                      ))}
                    </div>
                  ) : selectedRadioScheduleHref ? (
                    <div class="feed-chip-actions">
                      <a class="ghost-button compact" href={selectedRadioScheduleHref} rel="noreferrer" target="_blank">{selectedRadioStation?.scheduleLabel || 'Abrir grade oficial'}</a>
                    </div>
                  ) : null}
                </article>
              ) : null}
              <article class="feed-chip-card">
                <div>
                  <p class="section-tag">Outras radios</p>
                  <h3>{radioStations.length - 1} opcoes a um clique</h3>
                  <p class="helper-copy">A grade usa logos oficiais da BBC Sounds e da Global Player para manter a lista leve e legivel.</p>
                </div>
                <div class="feed-chip-actions">
                  {radioStations.slice(0, 6).map((item) => (
                    <button class="ghost-button compact" key={item.id} type="button" onClick={() => activateRadio(item.id)}>
                      {item.name}
                    </button>
                  ))}
                </div>
              </article>
            </div>
          </section>
        ) : (
          <section class="panel manager-panel">
            <div class="panel-heading">
              <div><p class="section-tag">Gerenciar feeds</p><h2>Twitch, YouTube, Kick e Cinema</h2></div>
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
                <p class="helper-copy">Twitch usa OAuth do navegador. YouTube nao precisa de API key e a leitura do status vem da pagina /live via proxy. Na Kick, o site ja consulta o status oficial pelo worker do app.</p>
              </div>
              <div class="subtle-card stack compact-card">
                <div class="field-grid compact">
                  <label><span>Plataforma</span><select value={embedDraft.platform} onChange={(event) => setEmbedDraft((current) => ({ ...current, platform: (event.currentTarget as HTMLSelectElement).value as 'twitch' | 'youtube' | 'kick' }))}><option value="twitch">Twitch</option><option value="youtube">YouTube</option><option value="kick">Kick</option></select></label>
                  <label><span>Canal</span><input placeholder={embedDraft.platform === 'youtube' ? '@vaush ou link do canal/live' : 'nome-do-canal'} value={embedDraft.channel} onInput={(event) => setEmbedDraft((current) => ({ ...current, channel: (event.currentTarget as HTMLInputElement).value }))} /></label>
                </div>
                <label><span>Titulo</span><input placeholder="Ex.: Stream secundaria" value={embedDraft.title} onInput={(event) => setEmbedDraft((current) => ({ ...current, title: (event.currentTarget as HTMLInputElement).value }))} /></label>
                <label><span>Endpoint de status opcional</span><input placeholder="https://seu-endpoint/status.json" value={embedDraft.statusEndpoint} onInput={(event) => setEmbedDraft((current) => ({ ...current, statusEndpoint: (event.currentTarget as HTMLInputElement).value }))} /></label>
                <button class="primary-button" type="button" onClick={addEmbed}>Adicionar feed</button>
                {embedDraft.platform === 'youtube' ? <p class="helper-copy">Pode colar `@handle`, URL do canal ou URL `/live`. O app tenta normalizar isso antes de salvar.</p> : null}
              </div>
              <div class="subtle-card stack compact-card">
                <div class="field-grid compact">
                  <label><span>Titulo do filme</span><input placeholder="Ex.: Filme no Drive" value={movieDraft.title} onInput={(event) => setMovieDraft((current) => ({ ...current, title: (event.currentTarget as HTMLInputElement).value }))} /></label>
                  <label><span>Link compartilhado do Drive</span><input placeholder="https://drive.google.com/file/d/.../view" value={movieDraft.driveUrl} onInput={(event) => setMovieDraft((current) => ({ ...current, driveUrl: (event.currentTarget as HTMLInputElement).value }))} /></label>
                </div>
                <button class="primary-button" type="button" onClick={addMovie}>Adicionar em Cinema</button>
                <p class="helper-copy">O site tenta abrir o arquivo em modo preview do Google Drive. Se o preview nao ficar bom, o botao Abrir no Drive fica disponivel no palco.</p>
              </div>
            </div>
            <div class="feed-chip-grid">
              {embeds.map((item) => {
                const status = statusMap[item.channel.toLowerCase()]
                return <article class="feed-chip-card" key={item.id}><div><p class="section-tag">{item.platform}</p><h3>{item.title}</h3><p class="helper-copy">{item.channel}</p></div><div class="feed-chip-actions"><span class={statusTone(status?.state || 'unknown', item.platform)}>{status?.label || 'Aguardando'}</span><button class="ghost-button compact" type="button" onClick={() => activateEmbed(item)}>Abrir</button><button class="ghost-button compact" type="button" onClick={() => removeEmbed(item.id)}>Remover</button></div></article>
              })}
              {movies.map((item) => (
                <article class="feed-chip-card" key={item.id}><div><p class="section-tag">cinema</p><h3>{item.title}</h3><p class="helper-copy">Google Drive preview</p></div><div class="feed-chip-actions"><button class="ghost-button compact" type="button" onClick={() => { setSelectedMovieId(item.id); setSurface('cinema') }}>Abrir</button><button class="ghost-button compact" type="button" onClick={() => removeMovie(item.id)}>Remover</button></div></article>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
