import type Hls from 'hls.js'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  buildTwitchAuthUrl,
  fetchCustomStatus,
  fetchM3UPlaylist,
  fetchTwitchStatuses,
  fetchXtreamPlaylist,
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
const DEFAULT_XTREAM_PROXY_URL = 'https://iptv-pages-hub-proxy.fabiogsilverio.workers.dev'

interface AppSettings {
  rememberConnection: boolean
  twitchClientId: string
  twitchAccessToken: string
}

interface PersistedFormState {
  sourceTab: 'xtream' | 'm3u'
  xtream: XtreamCredentials
  m3u: M3UCredentials
}

const defaultXtream: XtreamCredentials = {
  serverUrl: '',
  username: '',
  password: '',
  output: 'm3u8',
  proxyUrl: DEFAULT_XTREAM_PROXY_URL,
}
const defaultM3U: M3UCredentials = { url: '' }
const defaultSettings: AppSettings = {
  rememberConnection: true,
  twitchClientId: '',
  twitchAccessToken: '',
}
const embedDefaults: EmbedStream[] = [
  { id: crypto.randomUUID(), platform: 'twitch', channel: 'shroud', title: 'Twitch destaque' },
  { id: crypto.randomUUID(), platform: 'kick', channel: 'xqc', title: 'Kick destaque' },
]

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

function relativeTime(iso?: string) {
  if (!iso) return 'agora'
  const formatter = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
  const delta = Math.round((new Date(iso).getTime() - Date.now()) / 60000)
  if (Math.abs(delta) < 1) return 'agora'
  if (Math.abs(delta) < 60) return formatter.format(delta, 'minute')
  return formatter.format(Math.round(delta / 60), 'hour')
}

function statusTone(state: LiveState) {
  if (state === 'online') return 'status-chip online'
  if (state === 'offline') return 'status-chip offline'
  if (state === 'error') return 'status-chip error'
  return 'status-chip unknown'
}

function buildKickEmbedUrl(channel: string) {
  return `https://player.kick.com/${channel}?autoplay=false&muted=true`
}

function buildTwitchEmbedUrl(channel: string) {
  const parent = window.location.hostname || 'localhost'
  return `https://player.twitch.tv/?channel=${channel}&parent=${parent}&muted=true`
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
  const [settings, setSettings] = useState<AppSettings>(() => readJson(SETTINGS_KEY, defaultSettings))
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
  const [playerError, setPlayerError] = useState('')
  const [playerState, setPlayerState] = useState('Pronto para tocar')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)

  const channels = playlist?.channels ?? []
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
          const leftFavorite = favorites.includes(left.id) ? 1 : 0
          const rightFavorite = favorites.includes(right.id) ? 1 : 0
          if (leftFavorite !== rightFavorite) return rightFavorite - leftFavorite
          const groupCompare = left.group.localeCompare(right.group, 'pt-BR')
          if (groupCompare !== 0) return groupCompare
          return left.name.localeCompare(right.name, 'pt-BR')
        }),
    [channels, favorites, groupFilter, searchTerm],
  )

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === selectedChannelId) ?? visibleChannels[0] ?? null,
    [channels, selectedChannelId, visibleChannels],
  )
  const xtreamNeedsHttps = hasHttpUrl(xtream.serverUrl) && !xtream.proxyUrl?.trim() && window.location.protocol === 'https:'
  const xtreamHttpsSuggestion = xtreamNeedsHttps ? toHttpsUrl(xtream.serverUrl) : ''

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
  useEffect(() => {
    saveJson<PersistedFormState>(FORM_STATE_KEY, { sourceTab, xtream, m3u })
  }, [m3u, sourceTab, xtream])

  useEffect(() => {
    if (selectedChannel?.id) window.localStorage.setItem(LAST_CHANNEL_KEY, selectedChannel.id)
  }, [selectedChannel?.id])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !selectedChannel) return

    let cancelled = false
    const prefersHls = isLikelyHlsStream(selectedChannel.streamUrl)

    setPlayerError('')
    setPlayerState('Conectando stream...')

    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    video.pause()
    video.removeAttribute('src')
    video.load()

    const onWaiting = () => setPlayerState('Aguardando buffer...')
    const onPlaying = () => setPlayerState('Ao vivo')
    const onStalled = () => setPlayerState('Reconectando...')
    const onCanPlay = () => setPlayerState((current) => (current === 'Ao vivo' ? current : 'Stream pronta'))
    const onError = () => {
      setPlayerError('Nao foi possivel abrir a stream deste canal no navegador.')
      setPlayerState('Falha no player')
    }

    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('stalled', onStalled)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('error', onError)

    const boot = async () => {
      if (prefersHls) {
        const { default: HlsClient } = await import('hls.js')
        if (cancelled) return

        if (HlsClient.isSupported()) {
          const hls = new HlsClient({
            enableWorker: true,
            lowLatencyMode: true,
            backBufferLength: 20,
            liveSyncDurationCount: 2,
            liveMaxLatencyDurationCount: 6,
            maxBufferLength: 12,
            maxMaxBufferLength: 24,
            manifestLoadingTimeOut: 12000,
            levelLoadingTimeOut: 12000,
            fragLoadingTimeOut: 15000,
            manifestLoadingMaxRetry: 4,
            levelLoadingMaxRetry: 4,
            fragLoadingMaxRetry: 5,
          })

          hlsRef.current = hls
          hls.attachMedia(video)
          hls.on(HlsClient.Events.MEDIA_ATTACHED, () => hls.loadSource(selectedChannel.streamUrl))
          hls.on(HlsClient.Events.MANIFEST_PARSED, async () => {
            const nextState = await attemptPlayback(video, 'Clique em play para iniciar')
            if (!cancelled) setPlayerState(nextState)
          })
          hls.on(HlsClient.Events.ERROR, (_, data) => {
            if (!data.fatal) return
            if (data.type === HlsClient.ErrorTypes.NETWORK_ERROR) {
              setPlayerState('Reconectando stream...')
              hls.startLoad()
              return
            }
            if (data.type === HlsClient.ErrorTypes.MEDIA_ERROR) {
              setPlayerState('Recuperando player...')
              hls.recoverMediaError()
              return
            }
            setPlayerError(`Erro fatal no player: ${data.details}`)
            setPlayerState('Erro fatal')
          })
          return
        }
      }

      if (video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('video/mp2t') || !prefersHls) {
        video.src = selectedChannel.streamUrl
        const nextState = await attemptPlayback(video, 'Clique em play para iniciar')
        if (!cancelled) setPlayerState(nextState)
        return
      }

      setPlayerError('Seu navegador nao conseguiu abrir essa stream com o modo otimizado.')
      setPlayerState('Falha no player')
    }

    void boot()

    return () => {
      cancelled = true
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('stalled', onStalled)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('error', onError)
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [selectedChannel?.id])

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

      embeds
        .filter((item) => item.platform === 'kick' && !item.statusEndpoint?.trim())
        .forEach((item) => {
          const key = item.channel.toLowerCase()
          if (nextStatus[key]) return
          nextStatus[key] = {
            label: 'Sem API',
            state: 'unknown',
            detail: 'Kick permite embed oficial, mas o status em Pages precisa de endpoint externo.',
            updatedAt: new Date().toISOString(),
          }
        })

      if (isActive) setStatusMap(nextStatus)
    }

    void refresh()
    const interval = window.setInterval(() => void refresh(), 120000)
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
      const nextPlaylist = await fetchXtreamPlaylist(nextCredentials, controller.signal)
      setPlaylist(nextPlaylist)
      setSelectedChannelId(nextPlaylist.channels[0]?.id ?? null)
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
      const nextPlaylist = await fetchM3UPlaylist(credentials, controller.signal)
      setPlaylist(nextPlaylist)
      setSelectedChannelId(nextPlaylist.channels[0]?.id ?? null)
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

  function addEmbed() {
    if (!embedDraft.channel.trim()) return
    setEmbeds((current) => [
      {
        id: crypto.randomUUID(),
        platform: embedDraft.platform,
        channel: embedDraft.channel.trim(),
        title: embedDraft.title.trim() || `${embedDraft.platform} / ${embedDraft.channel.trim()}`,
        statusEndpoint: embedDraft.statusEndpoint?.trim() || undefined,
      },
      ...current,
    ])
    setEmbedDraft({ id: '', platform: 'twitch', channel: '', title: '', statusEndpoint: '' })
  }

  function toggleFavorite(channelId: string) {
    setFavorites((current) => (current.includes(channelId) ? current.filter((id) => id !== channelId) : [channelId, ...current]))
  }

  return (
    <div class="app-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">IPTV Pages Hub</p>
          <h1>Player leve, lista rapida e login salvo no navegador.</h1>
        </div>
        <div class="topbar-stats">
          <div class="stat-card">
            <span>Fonte</span>
            <strong>{playlist?.kind === 'xtream' ? 'Xtream' : playlist?.kind === 'm3u' ? 'M3U' : 'Nenhuma'}</strong>
          </div>
          <div class="stat-card">
            <span>Canais</span>
            <strong>{new Intl.NumberFormat('pt-BR').format(channels.length)}</strong>
          </div>
          <div class="stat-card">
            <span>Player</span>
            <strong>{playerState}</strong>
          </div>
        </div>
      </header>

      <main class="layout-grid">
        <section class="panel connect-panel">
          <div class="panel-heading compact-heading">
            <div>
              <p class="section-tag">Entrada</p>
              <h2>Conectar playlist</h2>
            </div>
            <div class="source-switch">
              <button class={sourceTab === 'xtream' ? 'active' : ''} type="button" onClick={() => setSourceTab('xtream')}>Xtream Codes</button>
              <button class={sourceTab === 'm3u' ? 'active' : ''} type="button" onClick={() => setSourceTab('m3u')}>M3U URL</button>
            </div>
          </div>

          {sourceTab === 'xtream' ? (
            <form class="stack" onSubmit={(event) => { event.preventDefault(); void connectXtream() }}>
              <label>
                <span>Servidor</span>
                <input
                  placeholder="http://ou-https://painel.exemplo.com"
                  value={xtream.serverUrl}
                  onInput={(event) => setXtream((current) => ({ ...current, serverUrl: (event.currentTarget as HTMLInputElement).value }))}
                />
              </label>
              <label>
                <span>Proxy HTTPS</span>
                <input
                  placeholder="https://seu-proxy.exemplo.workers.dev"
                  value={xtream.proxyUrl || ''}
                  onInput={(event) => setXtream((current) => ({ ...current, proxyUrl: (event.currentTarget as HTMLInputElement).value }))}
                />
              </label>
              {xtreamNeedsHttps ? (
                <div class="alert warn compact-alert">
                  <strong>Servidor em HTTP</strong>
                  <span>GitHub Pages roda em HTTPS. Sem proxy, o navegador bloqueia esse login.</span>
                  <div class="inline-actions">
                    <button class="ghost-button compact" type="button" onClick={() => setXtream((current) => ({ ...current, serverUrl: xtreamHttpsSuggestion }))}>
                      Trocar para {xtreamHttpsSuggestion}
                    </button>
                  </div>
                </div>
              ) : null}
              <div class="field-grid">
                <label>
                  <span>Usuario</span>
                  <input value={xtream.username} onInput={(event) => setXtream((current) => ({ ...current, username: (event.currentTarget as HTMLInputElement).value }))} />
                </label>
                <label>
                  <span>Senha</span>
                  <input type="password" value={xtream.password} onInput={(event) => setXtream((current) => ({ ...current, password: (event.currentTarget as HTMLInputElement).value }))} />
                </label>
              </div>
              <label>
                <span>Saida para browser</span>
                <select value={xtream.output} onChange={(event) => setXtream((current) => ({ ...current, output: (event.currentTarget as HTMLSelectElement).value as 'm3u8' | 'ts' }))}>
                  <option value="m3u8">m3u8 (recomendado)</option>
                  <option value="ts">ts</option>
                </select>
              </label>
              <button class="primary-button" disabled={isLoading} type="submit">{isLoading ? 'Carregando playlist...' : 'Entrar com Xtream'}</button>
            </form>
          ) : (
            <form class="stack" onSubmit={(event) => { event.preventDefault(); void connectM3U() }}>
              <label>
                <span>URL da playlist</span>
                <input
                  placeholder="https://exemplo.com/lista.m3u"
                  value={m3u.url}
                  onInput={(event) => setM3U({ url: (event.currentTarget as HTMLInputElement).value })}
                />
              </label>
              <button class="primary-button" disabled={isLoading} type="submit">{isLoading ? 'Lendo playlist...' : 'Abrir M3U'}</button>
            </form>
          )}

          <div class="subtle-card stack compact-card">
            <label class="check-row">
              <input checked={settings.rememberConnection} type="checkbox" onChange={(event) => setSettings((current) => ({ ...current, rememberConnection: (event.currentTarget as HTMLInputElement).checked }))} />
              <span>Lembrar e tentar reconectar neste navegador</span>
            </label>
            <p class="helper-copy">Os campos ficam salvos automaticamente aqui no browser, mesmo antes de conectar.</p>
          </div>

          {loadError ? <p class="alert error">{loadError}</p> : null}

          <div class="subtle-card info-grid">
            <div>
              <p class="section-tag">Origem atual</p>
              <h3>{playlist?.label || 'Nenhuma playlist conectada'}</h3>
              <p class="helper-copy">{playlist ? `${playlist.sourceLabel} - atualizado ${relativeTime(playlist.loadedAt)}` : 'Conecte uma fonte para listar canais.'}</p>
            </div>
            <div>
              <p class="section-tag">Prioridade</p>
              <h3>{favorites.length} favoritos</h3>
              <p class="helper-copy">Favoritos aparecem primeiro na lista carregada.</p>
            </div>
          </div>
        </section>

        <section class="panel browser-panel">
          <div class="panel-heading">
            <div>
              <p class="section-tag">Biblioteca</p>
              <h2>Canais</h2>
            </div>
            <div class="pill-row">
              <span class="pill">{favorites.length} favoritos</span>
              <span class="pill">{new Intl.NumberFormat('pt-BR').format(visibleChannels.length)} visiveis</span>
            </div>
          </div>

          <div class="field-grid compact">
            <label>
              <span>Buscar</span>
              <input placeholder="Nome, grupo ou EPG" value={searchTerm} onInput={(event) => setSearchTerm((event.currentTarget as HTMLInputElement).value)} />
            </label>
            <label>
              <span>Grupo</span>
              <select value={groupFilter} onChange={(event) => setGroupFilter((event.currentTarget as HTMLSelectElement).value)}>
                <option value="Todos">Todos</option>
                {(playlist?.groups ?? []).map((group) => <option key={group} value={group}>{group}</option>)}
              </select>
            </label>
          </div>

          <div class="channel-list">
            {visibleChannels.length ? visibleChannels.map((channel) => (
              <div
                key={channel.id}
                class={channel.id === selectedChannel?.id ? 'channel-card active' : 'channel-card'}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedChannelId(channel.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSelectedChannelId(channel.id)
                  }
                }}
              >
                <div class="channel-art">
                  {channel.logo ? <img alt={channel.name} loading="lazy" src={channel.logo} /> : <span>{channel.name.slice(0, 2).toUpperCase()}</span>}
                </div>
                <div class="channel-copy">
                  <div class="channel-topline">
                    <strong>{channel.name}</strong>
                    <button
                      aria-label={favorites.includes(channel.id) ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
                      class={favorites.includes(channel.id) ? 'favorite-button active' : 'favorite-button'}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleFavorite(channel.id)
                      }}
                    >
                      {favorites.includes(channel.id) ? 'Salvo' : 'Fav'}
                    </button>
                  </div>
                  <span>{channel.group}</span>
                </div>
              </div>
            )) : (
              <div class="empty-state">
                <strong>Nenhum canal encontrado.</strong>
                <span>Carregue uma playlist ou ajuste os filtros.</span>
              </div>
            )}
          </div>
        </section>

        <section class="panel player-panel">
          <div class="panel-heading">
            <div>
              <p class="section-tag">Player</p>
              <h2>{selectedChannel?.name || 'Selecione um canal'}</h2>
            </div>
            <div class="pill-row">
              {selectedChannel ? (
                <button class={favorites.includes(selectedChannel.id) ? 'favorite-pill active' : 'favorite-pill'} type="button" onClick={() => toggleFavorite(selectedChannel.id)}>
                  {favorites.includes(selectedChannel.id) ? 'Favorito' : 'Favoritar'}
                </button>
              ) : null}
              <span class="pill">{selectedChannel?.group || 'Sem grupo'}</span>
            </div>
          </div>

          <div class="player-frame">
            <video controls playsInline preload="auto" ref={videoRef} />
          </div>

          <div class="player-meta">
            <div class="subtle-card compact-card">
              <p class="section-tag">Status</p>
              <h3>{playerState}</h3>
              <p class="helper-copy">HLS fica no modo otimizado quando disponivel, com retomada mais agressiva em stream ao vivo.</p>
            </div>
            <div class="subtle-card compact-card">
              <p class="section-tag">URL da stream</p>
              <h3 class="small-text">{selectedChannel?.streamUrl || 'Aguardando selecao de canal'}</h3>
            </div>
          </div>

          {playerError ? <p class="alert error">{playerError}</p> : null}
        </section>

        <section class="panel embed-panel">
          <div class="panel-heading">
            <div>
              <p class="section-tag">Embeds</p>
              <h2>Twitch e Kick</h2>
            </div>
            <span class="pill">{embeds.length} embeds</span>
          </div>

          <div class="embed-tools">
            <div class="subtle-card stack compact-card">
              <div class="field-grid compact">
                <label>
                  <span>Twitch Client ID</span>
                  <input
                    placeholder="Para status oficial da Twitch"
                    value={settings.twitchClientId}
                    onInput={(event) => setSettings((current) => ({ ...current, twitchClientId: (event.currentTarget as HTMLInputElement).value }))}
                  />
                </label>
                <label>
                  <span>Twitch token</span>
                  <input
                    placeholder="Preenchido via OAuth"
                    value={settings.twitchAccessToken}
                    onInput={(event) => setSettings((current) => ({ ...current, twitchAccessToken: (event.currentTarget as HTMLInputElement).value }))}
                  />
                </label>
              </div>
              <div class="button-row">
                <button class="ghost-button" type="button" onClick={connectTwitch}>Conectar Twitch OAuth</button>
              </div>
              <p class="helper-copy">Twitch pode mostrar status oficial com OAuth. Kick usa embed oficial e pode ganhar status externo se voce informar um endpoint seu.</p>
            </div>

            <div class="subtle-card stack compact-card">
              <div class="field-grid compact">
                <label>
                  <span>Plataforma</span>
                  <select value={embedDraft.platform} onChange={(event) => setEmbedDraft((current) => ({ ...current, platform: (event.currentTarget as HTMLSelectElement).value as 'twitch' | 'kick' }))}>
                    <option value="twitch">Twitch</option>
                    <option value="kick">Kick</option>
                  </select>
                </label>
                <label>
                  <span>Canal</span>
                  <input placeholder="nome-do-canal" value={embedDraft.channel} onInput={(event) => setEmbedDraft((current) => ({ ...current, channel: (event.currentTarget as HTMLInputElement).value }))} />
                </label>
              </div>
              <label>
                <span>Titulo</span>
                <input placeholder="Ex.: Stream secundaria" value={embedDraft.title} onInput={(event) => setEmbedDraft((current) => ({ ...current, title: (event.currentTarget as HTMLInputElement).value }))} />
              </label>
              <label>
                <span>Endpoint de status opcional</span>
                <input placeholder="https://seu-endpoint/status.json" value={embedDraft.statusEndpoint} onInput={(event) => setEmbedDraft((current) => ({ ...current, statusEndpoint: (event.currentTarget as HTMLInputElement).value }))} />
              </label>
              <button class="primary-button" type="button" onClick={addEmbed}>Adicionar embed</button>
            </div>
          </div>

          <div class="embed-grid">
            {embeds.map((item) => {
              const status = statusMap[item.channel.toLowerCase()]
              return (
                <article class="embed-card" key={item.id}>
                  <div class="embed-header">
                    <div>
                      <p class="section-tag">{item.platform}</p>
                      <h3>{item.title}</h3>
                    </div>
                    <button class="ghost-button compact" type="button" onClick={() => setEmbeds((current) => current.filter((entry) => entry.id !== item.id))}>
                      Remover
                    </button>
                  </div>
                  <div class="status-row">
                    <span class={statusTone(status?.state || 'unknown')}>{status?.label || 'Aguardando'}</span>
                    <small>{status?.detail || 'Consultando status...'}</small>
                  </div>
                  <div class="embed-frame">
                    <iframe
                      allow="autoplay; fullscreen"
                      loading="lazy"
                      src={item.platform === 'twitch' ? buildTwitchEmbedUrl(item.channel) : buildKickEmbedUrl(item.channel)}
                      title={item.title}
                    />
                  </div>
                  <p class="helper-copy">Ultima atualizacao {relativeTime(status?.updatedAt)}.</p>
                </article>
              )
            })}
          </div>
        </section>
      </main>
    </div>
  )
}
