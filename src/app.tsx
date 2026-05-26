import type Hls from 'hls.js'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { fetchM3UPlaylist, type Channel, type PlaylistSession } from './lib/iptv'

type AppView = 'live' | 'iptv' | 'links'
type PlayerState = 'idle' | 'loading' | 'ready' | 'playing' | 'error'

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
  note: string
}

const M3U_URL_KEY = 'iptv-pages-lite.m3u-url'
const LAST_NATIVE_KEY = 'iptv-pages-lite.last-native'
const LAST_VIEW_KEY = 'iptv-pages-lite.view'

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

const viewLabels: Record<AppView, string> = {
  live: 'Ao vivo',
  iptv: 'IPTV',
  links: 'Links',
}

function readStoredValue(key: string) {
  if (typeof window === 'undefined') return ''

  return window.localStorage.getItem(key) || ''
}

function viewFromHash(hash: string): AppView | null {
  const value = hash.replace('#', '')
  return value === 'iptv' || value === 'links' || value === 'live' ? value : null
}

function readInitialView(): AppView {
  if (typeof window === 'undefined') return 'live'

  const hashView = viewFromHash(window.location.hash)
  if (hashView) return hashView

  const stored = readStoredValue(LAST_VIEW_KEY)
  return stored === 'iptv' || stored === 'links' || stored === 'live' ? stored : 'live'
}

function compactUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    return `${url.host}${url.pathname.length > 34 ? `${url.pathname.slice(0, 34)}...` : url.pathname}`
  } catch {
    return rawUrl
  }
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
    note: channel.logo ? 'Canal carregado da playlist importada.' : 'Canal da playlist importada.',
  }
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

function Icon({ name }: { name: 'play' | 'reload' | 'external' | 'search' | 'list' | 'link' }) {
  const paths = {
    play: <path d="M8 5v14l11-7z" />,
    reload: <path d="M20 6v5h-5M4 18v-5h5M18.7 9A7 7 0 0 0 6.2 6.7L4 9m2 6a7 7 0 0 0 11.8 2.3L20 15" />,
    external: <path d="M14 4h6v6M13 11l7-7M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />,
    search: <path d="m21 21-4.3-4.3M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4z" />,
    list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
    link: <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" />,
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

  const [view, setView] = useState<AppView>(() => readInitialView())
  const [selectedNativeId, setSelectedNativeId] = useState(() => readStoredValue(LAST_NATIVE_KEY) || verifiedFeeds[0].id)
  const [playerState, setPlayerState] = useState<PlayerState>('idle')
  const [playerError, setPlayerError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [isMuted, setIsMuted] = useState(true)
  const [query, setQuery] = useState('')
  const [m3uUrl, setM3uUrl] = useState(() => readStoredValue(M3U_URL_KEY))
  const [playlist, setPlaylist] = useState<PlaylistSession | null>(null)
  const [playlistState, setPlaylistState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [playlistError, setPlaylistError] = useState('')
  const [selectedGroup, setSelectedGroup] = useState('Todos')
  const [selectedChannelId, setSelectedChannelId] = useState('')

  const selectedNative = useMemo(
    () => verifiedFeeds.find((feed) => feed.id === selectedNativeId) || verifiedFeeds[0],
    [selectedNativeId],
  )

  const filteredNativeFeeds = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized || view !== 'live') return verifiedFeeds

    return verifiedFeeds.filter((feed) =>
      `${feed.name} ${feed.group} ${feed.region} ${feed.source}`.toLowerCase().includes(normalized),
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

  const selectedChannel = useMemo(
    () => playlist?.channels.find((channel) => channel.id === selectedChannelId) || filteredChannels[0] || null,
    [filteredChannels, playlist, selectedChannelId],
  )

  const activeItem = view === 'iptv' && selectedChannel
    ? channelToPlayerItem(selectedChannel)
    : selectedNative

  const groupedLinks = useMemo(() => {
    return externalLinks.reduce<Record<string, ExternalFeedLink[]>>((groups, link) => {
      groups[link.group] = groups[link.group] || []
      groups[link.group].push(link)
      return groups
    }, {})
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
    if (typeof window === 'undefined') return

    window.localStorage.setItem(LAST_NATIVE_KEY, selectedNativeId)
  }, [selectedNativeId])

  useEffect(() => {
    if (typeof window === 'undefined') return

    window.localStorage.setItem(M3U_URL_KEY, m3uUrl)
  }, [m3uUrl])

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
        media.muted = isMuted
        await media.play()
      } catch {
        if (!cancelled) setPlayerState('ready')
      }
    }

    async function loadStream() {
      destroyHls()
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

      if (!isHls) {
        media.src = streamUrl
        media.load()
        await playWhenPossible()
        return
      }

      if (media.canPlayType('application/vnd.apple.mpegurl')) {
        media.src = streamUrl
        media.load()
        await playWhenPossible()
        return
      }

      const { default: HlsClient } = await import('hls.js')
      if (!HlsClient.isSupported()) {
        setPlayerState('error')
        setPlayerError('Este navegador nao oferece suporte HLS neste modo.')
        return
      }

      const hls = new HlsClient({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 60,
        liveSyncDurationCount: 3,
      })

      hlsRef.current = hls
      hls.attachMedia(media)
      hls.on(HlsClient.Events.MEDIA_ATTACHED, () => hls.loadSource(streamUrl))
      hls.on(HlsClient.Events.MANIFEST_PARSED, () => {
        void playWhenPossible()
      })
      hls.on(HlsClient.Events.ERROR, (_event, data: { fatal?: boolean; type?: string }) => {
        if (!data.fatal) return

        if (data.type === 'networkError') {
          setPlayerError('Oscilacao de rede. Tentando religar a stream.')
          hls.startLoad()
          return
        }

        if (data.type === 'mediaError') {
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
    }
  }, [activeItem?.streamUrl, isMuted, reloadToken])

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

  function selectChannel(channelId: string) {
    setSelectedChannelId(channelId)
    setView('iptv')
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
          <p>Player nativo leve com feeds testados e playlist M3U.</p>
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
          <div class="player-frame">
            <video
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
              <h2>{view === 'links' ? 'Fontes externas' : 'Guia'}</h2>
            </div>
            <label class="search-box">
              <Icon name="search" />
              <input
                placeholder={view === 'iptv' ? 'Buscar na playlist' : 'Buscar feed'}
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
                    <small>{feed.region} · {feed.source}</small>
                  </span>
                  <em>{feed.quality}</em>
                </button>
              ))}
            </div>
          ) : null}

          {view === 'iptv' ? (
            <div class="iptv-panel">
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

              {playlist ? (
                <div class="playlist-tools">
                  <select
                    aria-label="Filtrar grupo"
                    value={selectedGroup}
                    onChange={(event) => setSelectedGroup((event.currentTarget as HTMLSelectElement).value)}
                  >
                    {playlistGroups.map((group) => (
                      <option key={group} value={group}>{group}</option>
                    ))}
                  </select>
                  <span>{filteredChannels.length} de {playlist.channels.length} canais</span>
                </div>
              ) : null}

              {playlistError ? <p class="inline-alert">{playlistError}</p> : null}

              <div class="channel-list">
                {filteredChannels.map((channel) => (
                  <button
                    class={classNames('channel-row', selectedChannel?.id === channel.id && 'selected')}
                    key={channel.id}
                    type="button"
                    onClick={() => selectChannel(channel.id)}
                  >
                    <span class="channel-mark">{channel.name.slice(0, 2).toUpperCase()}</span>
                    <span>
                      <strong>{channel.name}</strong>
                      <small>{channel.group}</small>
                    </span>
                    <em>{channel.streamUrl.toLowerCase().includes('.m3u8') ? 'HLS' : 'Auto'}</em>
                  </button>
                ))}
              </div>

              {!playlist && !playlistError ? (
                <div class="empty-panel">
                  <Icon name="list" />
                  <p>Carregue uma playlist para montar o guia IPTV.</p>
                </div>
              ) : null}
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
