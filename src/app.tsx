import type Hls from 'hls.js'
import { useEffect, useRef, useState } from 'preact/hooks'
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

interface AppSettings {
  rememberConnection: boolean
  twitchClientId: string
  twitchAccessToken: string
}

const defaultXtream: XtreamCredentials = {
  serverUrl: '',
  username: '',
  password: '',
  output: 'm3u8',
  proxyUrl: '',
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

export function App() {
  const [sourceTab, setSourceTab] = useState<'xtream' | 'm3u'>('xtream')
  const [xtream, setXtream] = useState<XtreamCredentials>(defaultXtream)
  const [m3u, setM3U] = useState<M3UCredentials>(defaultM3U)
  const [settings, setSettings] = useState<AppSettings>(() => readJson(SETTINGS_KEY, defaultSettings))
  const [playlist, setPlaylist] = useState<PlaylistSession | null>(null)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    () => window.localStorage.getItem(LAST_CHANNEL_KEY),
  )
  const [searchTerm, setSearchTerm] = useState('')
  const [groupFilter, setGroupFilter] = useState('Todos')
  const [favorites, setFavorites] = useState<string[]>(() => readJson(FAVORITES_KEY, [] as string[]))
  const [embeds, setEmbeds] = useState<EmbedStream[]>(() => readJson(EMBEDS_KEY, embedDefaults))
  const [embedDraft, setEmbedDraft] = useState<EmbedStream>({
    id: '',
    platform: 'twitch',
    channel: '',
    title: '',
    statusEndpoint: '',
  })
  const [statusMap, setStatusMap] = useState<Record<string, EmbedStatus>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [playerError, setPlayerError] = useState('')
  const [playerState, setPlayerState] = useState('Pronto para tocar')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)

  const channels = playlist?.channels ?? []
  const visibleChannels = channels.filter((channel) => {
    const matchesGroup = groupFilter === 'Todos' || channel.group === groupFilter
    const search = searchTerm.trim().toLowerCase()
    const matchesSearch =
      !search ||
      channel.name.toLowerCase().includes(search) ||
      channel.group.toLowerCase().includes(search) ||
      channel.tvgId?.toLowerCase().includes(search)
    return matchesGroup && matchesSearch
  }).sort((left, right) => {
    const leftFavorite = favorites.includes(left.id) ? 1 : 0
    const rightFavorite = favorites.includes(right.id) ? 1 : 0
    if (leftFavorite !== rightFavorite) return rightFavorite - leftFavorite
    const groupCompare = left.group.localeCompare(right.group, 'pt-BR')
    if (groupCompare !== 0) return groupCompare
    return left.name.localeCompare(right.name, 'pt-BR')
  })
  const selectedChannel =
    channels.find((channel) => channel.id === selectedChannelId) ?? visibleChannels[0] ?? null
  const xtreamNeedsHttps =
    hasHttpUrl(xtream.serverUrl) &&
    !xtream.proxyUrl?.trim() &&
    window.location.protocol === 'https:'
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

    const storedConnection = readJson<PersistedConnection | null>(CONNECTION_KEY, null)
    if (!storedConnection?.remember) return

    setXtream(storedConnection.xtream)
    setM3U(storedConnection.m3u)
    setSourceTab(storedConnection.kind)

    if (storedConnection.kind === 'xtream' && storedConnection.xtream.serverUrl) {
      void connectXtream(storedConnection.xtream, false)
    }

    if (storedConnection.kind === 'm3u' && storedConnection.m3u.url) {
      void connectM3U(storedConnection.m3u, false)
    }
  }, [])

  useEffect(() => saveJson(EMBEDS_KEY, embeds), [embeds])
  useEffect(() => saveJson(SETTINGS_KEY, settings), [settings])
  useEffect(() => saveJson(FAVORITES_KEY, favorites), [favorites])

  useEffect(() => {
    if (selectedChannel?.id) window.localStorage.setItem(LAST_CHANNEL_KEY, selectedChannel.id)
  }, [selectedChannel?.id])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !selectedChannel) return
    let cancelled = false

    setPlayerError('')
    setPlayerState('Conectando stream...')

    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    video.pause()
    video.removeAttribute('src')
    video.load()

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = selectedChannel.streamUrl
      void video.play().catch(() => undefined)
      setPlayerState('Tocando em modo nativo')
      return
    }

    const onWaiting = () => setPlayerState('Aguardando buffer...')
    const onPlaying = () => setPlayerState('Ao vivo')
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)

    const boot = async () => {
      const { default: HlsClient } = await import('hls.js')

      if (cancelled) return

      if (!HlsClient.isSupported()) {
        setPlayerError('Seu navegador nao suporta HLS nativamente e o fallback nao esta disponivel.')
        setPlayerState('Falha no player')
        return
      }

      const hls = new HlsClient({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        maxBufferLength: 20,
        maxMaxBufferLength: 40,
        manifestLoadingTimeOut: 10000,
        fragLoadingTimeOut: 15000,
      })

      hlsRef.current = hls
      hls.loadSource(selectedChannel.streamUrl)
      hls.attachMedia(video)
      hls.on(HlsClient.Events.MANIFEST_PARSED, () => {
        setPlayerState('Manifest carregado')
        void video.play().catch(() => undefined)
      })
      hls.on(HlsClient.Events.ERROR, (_, data) => {
        if (!data.fatal) return
        setPlayerError(`Erro fatal no player: ${data.details}`)
        setPlayerState('Erro fatal')
        if (data.type === HlsClient.ErrorTypes.NETWORK_ERROR) hls.startLoad()
        if (data.type === HlsClient.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
      })
    }

    void boot()

    return () => {
      cancelled = true
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onPlaying)
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
          Object.assign(
            nextStatus,
            await fetchTwitchStatuses(
              twitchChannels,
              settings.twitchClientId,
              settings.twitchAccessToken,
            ),
          )
        } catch (error) {
          const detail = error instanceof Error ? error.message : TWITCH_STATUS_HELP
          twitchChannels.forEach((channel) => {
            nextStatus[channel] = {
              label: 'Erro',
              state: 'error',
              detail,
              updatedAt: new Date().toISOString(),
            }
          })
        }
      } else {
        twitchChannels.forEach((channel) => {
          nextStatus[channel] = {
            label: 'Sem auth',
            state: 'unknown',
            detail: TWITCH_STATUS_HELP,
            updatedAt: new Date().toISOString(),
          }
        })
      }

      await Promise.all(
        embeds
          .filter((item) => item.statusEndpoint?.trim())
          .map(async (item) => {
            try {
              nextStatus[item.channel.toLowerCase()] = await fetchCustomStatus(
                item.statusEndpoint!.trim(),
              )
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
    try {
      setIsLoading(true)
      setLoadError('')
      const nextPlaylist = await fetchXtreamPlaylist(credentials, controller.signal)
      setPlaylist(nextPlaylist)
      setSelectedChannelId(nextPlaylist.channels[0]?.id ?? null)
      if (persist) {
        saveJson<PersistedConnection>(CONNECTION_KEY, {
          kind: 'xtream',
          remember: settings.rememberConnection,
          xtream: credentials,
          m3u,
        })
      }
    } catch (error) {
      setLoadError(formatXtreamError(error, credentials.serverUrl))
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
      if (persist) {
        saveJson<PersistedConnection>(CONNECTION_KEY, {
          kind: 'm3u',
          remember: settings.rememberConnection,
          xtream,
          m3u: credentials,
        })
      }
    } catch (error) {
      setLoadError(formatM3UError(error, credentials.url))
    } finally {
      setIsLoading(false)
    }
  }

  function connectTwitch() {
    if (settings.twitchClientId.trim()) {
      window.location.href = buildTwitchAuthUrl(settings.twitchClientId)
    }
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
    setFavorites((current) =>
      current.includes(channelId)
        ? current.filter((id) => id !== channelId)
        : [channelId, ...current],
    )
  }

  return (
    <div class="app-shell">
      <header class="hero">
        <div>
          <p class="eyebrow">GitHub Pages IPTV Control Deck</p>
          <h1>Player enxuto para IPTV, Twitch e Kick.</h1>
          <p class="hero-copy">
            Interface client-side focada em troca rapida de canal, parsing em background e baixo
            overhead no browser. O desempenho final ainda depende do provedor e da rede.
          </p>
        </div>
        <div class="hero-metrics">
          <div class="metric-card">
            <strong>{new Intl.NumberFormat('pt-BR').format(channels.length)}</strong>
            <span>canais carregados</span>
          </div>
          <div class="metric-card">
            <strong>{playlist?.kind === 'xtream' ? 'Xtream' : playlist?.kind === 'm3u' ? 'M3U' : '---'}</strong>
            <span>fonte atual</span>
          </div>
          <div class="metric-card">
            <strong>{playerState}</strong>
            <span>estado do player</span>
          </div>
        </div>
      </header>

      <main class="layout-grid">
        <section class="panel connect-panel">
          <div class="panel-heading">
            <div>
              <p class="section-tag">Entrada</p>
              <h2>Conectar playlist</h2>
            </div>
            <div class="source-switch">
              <button class={sourceTab === 'xtream' ? 'active' : ''} type="button" onClick={() => setSourceTab('xtream')}>
                Xtream Codes
              </button>
              <button class={sourceTab === 'm3u' ? 'active' : ''} type="button" onClick={() => setSourceTab('m3u')}>
                M3U URL
              </button>
            </div>
          </div>

          {sourceTab === 'xtream' ? (
            <form class="stack" onSubmit={(event) => { event.preventDefault(); void connectXtream() }}>
              <label>
                <span>Servidor</span>
                <input
                  placeholder="https://painel.exemplo.com:443"
                  value={xtream.serverUrl}
                  onInput={(event) => setXtream((current) => ({ ...current, serverUrl: (event.currentTarget as HTMLInputElement).value }))}
                />
              </label>
              <label>
                <span>Proxy HTTPS opcional</span>
                <input
                  placeholder="https://seu-proxy.exemplo.workers.dev"
                  value={xtream.proxyUrl || ''}
                  onInput={(event) =>
                    setXtream((current) => ({
                      ...current,
                      proxyUrl: (event.currentTarget as HTMLInputElement).value,
                    }))
                  }
                />
              </label>
              {xtreamNeedsHttps ? (
                <div class="alert warn compact-alert">
                  <strong>Servidor em HTTP</strong>
                  <span>
                    O site publicado em GitHub Pages roda em HTTPS e o navegador bloqueia esse
                    login. Tente a versao segura do mesmo host ou preencha um proxy HTTPS acima.
                  </span>
                  <div class="inline-actions">
                    <button
                      class="ghost-button compact"
                      type="button"
                      onClick={() =>
                        setXtream((current) => ({ ...current, serverUrl: xtreamHttpsSuggestion }))
                      }
                    >
                      Trocar para {xtreamHttpsSuggestion}
                    </button>
                  </div>
                </div>
              ) : null}
              <div class="field-grid">
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
              <label>
                <span>Saida para browser</span>
                <select
                  value={xtream.output}
                  onChange={(event) => setXtream((current) => ({ ...current, output: (event.currentTarget as HTMLSelectElement).value as 'm3u8' | 'ts' }))}
                >
                  <option value="m3u8">m3u8 (recomendado)</option>
                  <option value="ts">ts</option>
                </select>
              </label>
              <button class="primary-button" disabled={isLoading} type="submit">
                {isLoading ? 'Carregando...' : 'Entrar com Xtream'}
              </button>
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
              <button class="primary-button" disabled={isLoading} type="submit">
                {isLoading ? 'Lendo playlist...' : 'Abrir M3U'}
              </button>
            </form>
          )}

          <div class="subtle-card">
            <label class="check-row">
              <input
                checked={settings.rememberConnection}
                type="checkbox"
                onChange={(event) => setSettings((current) => ({ ...current, rememberConnection: (event.currentTarget as HTMLInputElement).checked }))}
              />
              <span>Lembrar ultima conexao apenas neste navegador</span>
            </label>
            <p class="helper-copy">
              Credenciais ficam locais no navegador. Para Xtream HTTP-only em Pages, use um proxy
              HTTPS.
            </p>
          </div>

          {loadError ? <p class="alert error">{loadError}</p> : null}

          <div class="subtle-card">
            <p class="section-tag">Origem atual</p>
            <h3>{playlist?.label || 'Nenhuma playlist conectada'}</h3>
            <p class="helper-copy">
              {playlist ? `${playlist.sourceLabel} - atualizado ${relativeTime(playlist.loadedAt)}` : 'Conecte uma fonte para listar canais e iniciar o player.'}
            </p>
          </div>
        </section>

        <section class="panel browser-panel">
          <div class="panel-heading">
            <div>
              <p class="section-tag">Biblioteca</p>
              <h2>Busca e troca instantanea</h2>
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
                      ★
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
                <button
                  class={favorites.includes(selectedChannel.id) ? 'favorite-pill active' : 'favorite-pill'}
                  type="button"
                  onClick={() => toggleFavorite(selectedChannel.id)}
                >
                  {favorites.includes(selectedChannel.id) ? 'Favorito' : 'Favoritar'}
                </button>
              ) : null}
              <span class="pill">{selectedChannel?.group || 'Sem grupo'}</span>
            </div>
          </div>

          <div class="player-frame"><video controls playsInline ref={videoRef} /></div>

          <div class="player-meta">
            <div class="subtle-card">
              <p class="section-tag">Status</p>
              <h3>{playerState}</h3>
              <p class="helper-copy">HLS otimizado com worker ativo, buffer curto e foco em streams ao vivo.</p>
            </div>
            <div class="subtle-card">
              <p class="section-tag">URL da stream</p>
              <h3 class="small-text">{selectedChannel?.streamUrl || 'Aguardando selecao de canal'}</h3>
            </div>
          </div>

          {playerError ? <p class="alert error">{playerError}</p> : null}
        </section>

        <section class="panel embed-panel">
          <div class="panel-heading">
            <div>
              <p class="section-tag">Embed Zone</p>
              <h2>Twitch e Kick</h2>
            </div>
            <span class="pill">{embeds.length} embeds</span>
          </div>

          <div class="subtle-card stack">
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
            <div class="button-row"><button class="ghost-button" type="button" onClick={connectTwitch}>Conectar Twitch OAuth</button></div>
            <p class="helper-copy">
              Para Twitch, o status on/off usa API oficial quando voce registra seu Client ID. Para Kick, o embed e oficial, mas o status em Pages precisa de um endpoint externo seu.
            </p>
          </div>

          <div class="subtle-card stack">
            <div class="field-grid compact">
              <label>
                <span>Plataforma</span>
                <select
                  value={embedDraft.platform}
                  onChange={(event) => setEmbedDraft((current) => ({ ...current, platform: (event.currentTarget as HTMLSelectElement).value as 'twitch' | 'kick' }))}
                >
                  <option value="twitch">Twitch</option>
                  <option value="kick">Kick</option>
                </select>
              </label>
              <label>
                <span>Canal</span>
                <input
                  placeholder="nome-do-canal"
                  value={embedDraft.channel}
                  onInput={(event) => setEmbedDraft((current) => ({ ...current, channel: (event.currentTarget as HTMLInputElement).value }))}
                />
              </label>
            </div>
            <label>
              <span>Titulo</span>
              <input
                placeholder="Ex.: Stream secundaria"
                value={embedDraft.title}
                onInput={(event) => setEmbedDraft((current) => ({ ...current, title: (event.currentTarget as HTMLInputElement).value }))}
              />
            </label>
            <label>
              <span>Endpoint de status opcional</span>
              <input
                placeholder="https://seu-endpoint/status.json"
                value={embedDraft.statusEndpoint}
                onInput={(event) => setEmbedDraft((current) => ({ ...current, statusEndpoint: (event.currentTarget as HTMLInputElement).value }))}
              />
            </label>
            <button class="primary-button" type="button" onClick={addEmbed}>Adicionar embed</button>
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
