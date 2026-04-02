import { buildProxyUrl } from './iptv'
import type { RadioStation } from './radios'

export interface RadioGuideEntry {
  title: string
  subtitle: string
  description: string
  timeLabel: string
  imageUrl?: string
  isLive?: boolean
}

export interface RadioGuideSnapshot {
  providerLabel: string
  now: RadioGuideEntry | null
  upcoming: RadioGuideEntry[]
  updatedAt: string
}

const GUIDE_CACHE_TTL_MS = 4 * 60_000
const radioGuideCache = new Map<string, { expiresAt: number; snapshot: RadioGuideSnapshot }>()

interface BbcNextData {
  props?: {
    pageProps?: {
      dehydratedState?: {
        queries?: Array<{
          queryKey?: unknown
          state?: {
            data?: {
              data?: Array<{
                id?: string
                data?: Array<{
                  type?: string
                  start?: string
                  end?: string
                  titles?: {
                    primary?: string
                    secondary?: string
                  }
                  synopses?: {
                    short?: string
                    medium?: string
                  }
                  image_url?: string
                }>
              }>
            }
          }
        }>
      }
    }
  }
}

interface TimesNowPlayingResult {
  pi?: {
    programmeName?: string
    programmeDescription?: string
    imageUrl?: string
    startTime?: string
    stopTime?: string
  }
}

interface TimesScheduleResult {
  programmeName?: string
  programmeDescription?: string
  imageUrl?: string
  startTime?: string
  stopTime?: string
}

declare global {
  interface Window {
    [key: string]: unknown
  }
}

function normalizeText(value: unknown) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatTimeRange(startAt: Date, endAt: Date, timeZone = 'Europe/London') {
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  })

  return `${formatter.format(startAt)} - ${formatter.format(endAt)}`
}

function formatRangeFromIso(startAt: string, endAt: string, timeZone = 'Europe/London') {
  const start = new Date(startAt)
  const end = new Date(endAt)

  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return ''
  }

  return formatTimeRange(start, end, timeZone)
}

function formatRangeFromEpoch(startSeconds: string, endSeconds: string, timeZone = 'Europe/London') {
  const normalizedStart = normalizeText(startSeconds)
  const normalizedEnd = normalizeText(endSeconds)
  if (!/^\d+$/.test(normalizedStart) || !/^\d+$/.test(normalizedEnd)) {
    return ''
  }

  const start = Number(normalizedStart) * 1000
  const end = Number(normalizedEnd) * 1000

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return ''
  }

  return formatTimeRange(new Date(start), new Date(end), timeZone)
}

function parseNextDataScript<T>(html: string) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i)
  if (!match) {
    throw new Error('Nao achei os dados oficiais da grade.')
  }

  return JSON.parse(match[1]) as T
}

async function fetchHtmlViaProxy(targetUrl: string, proxyBase: string) {
  const response = await fetch(buildProxyUrl(proxyBase, targetUrl), {
    headers: {
      Accept: 'text/html',
      'User-Agent': 'Mozilla/5.0',
    },
  })

  if (!response.ok) {
    throw new Error('A fonte oficial nao respondeu agora.')
  }

  return response.text()
}

function resolveBbcServiceId(station: RadioStation) {
  const match = station.href.match(/\/live\/([^/?#]+)/i)
  return match?.[1] || ''
}

async function loadBbcGuide(station: RadioStation, proxyBase: string) {
  const serviceId = resolveBbcServiceId(station)
  if (!serviceId) {
    throw new Error('Nao consegui identificar o id oficial da BBC para essa radio.')
  }

  const html = await fetchHtmlViaProxy(station.href, proxyBase)
  const nextData = parseNextDataScript<BbcNextData>(html)
  const queries = nextData.props?.pageProps?.dehydratedState?.queries || []
  const experienceQuery = queries.find((query) =>
    JSON.stringify(query.queryKey || []).includes(`/v2/experience/inline/play/${serviceId}`),
  )

  const liveModule = experienceQuery?.state?.data?.data?.find((item) => item?.id === 'live_play_area')
  const broadcasts = (liveModule?.data || []).filter((item) => item?.type === 'broadcast_summary')

  if (!broadcasts.length) {
    throw new Error('A BBC nao expôs a grade dessa radio agora.')
  }

  const nowMs = Date.now()
  const entries = broadcasts.map((broadcast) => {
    const start = String(broadcast.start || '')
    const end = String(broadcast.end || '')
    const imageUrl = normalizeText(broadcast.image_url).replace('{recipe}', '320x320')

    return {
      title: normalizeText(broadcast.titles?.primary) || station.name,
      subtitle: normalizeText(broadcast.titles?.secondary),
      description: normalizeText(broadcast.synopses?.short || broadcast.synopses?.medium),
      timeLabel: formatRangeFromIso(start, end),
      imageUrl: imageUrl || undefined,
      isLive: Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end))
        ? nowMs >= Date.parse(start) && nowMs < Date.parse(end)
        : false,
    } satisfies RadioGuideEntry
  })

  const liveIndex = entries.findIndex((entry) => entry.isLive)
  const now = entries[liveIndex >= 0 ? liveIndex : 0] || null
  const upcoming = entries
    .filter((_, index) => index !== (liveIndex >= 0 ? liveIndex : 0))
    .slice(0, 5)

  return {
    providerLabel: 'BBC Sounds oficial',
    now,
    upcoming,
    updatedAt: new Date().toISOString(),
  } satisfies RadioGuideSnapshot
}

function extractTextLines(html: string) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  return (doc.body.textContent || '')
    .split('\n')
    .map((line) => normalizeText(line))
    .filter(Boolean)
}

function isUkTimeRangeLine(value: string) {
  return /^\d{1,2}(?::\d{2})?(?:am|pm)\s*-\s*\d{1,2}(?::\d{2})?(?:am|pm)$/i.test(value)
}

async function loadLbcGuide(proxyBase: string) {
  const scheduleUrl = 'https://www.lbc.co.uk/radio/schedule/lbc/'
  const html = await fetchHtmlViaProxy(scheduleUrl, proxyBase)
  const lines = extractTextLines(html)
  const scheduleIndex = lines.findIndex((line) => /^schedule$/i.test(line))
  const relevantLines = scheduleIndex >= 0 ? lines.slice(scheduleIndex) : lines
  const entries: RadioGuideEntry[] = []

  for (let index = 0; index < relevantLines.length; index += 1) {
    const line = relevantLines[index]
    if (!isUkTimeRangeLine(line)) continue

    let title = ''
    for (let nextIndex = index + 1; nextIndex < Math.min(relevantLines.length, index + 8); nextIndex += 1) {
      const candidate = relevantLines[nextIndex]
      if (
        !candidate ||
        isUkTimeRangeLine(candidate) ||
        /^(schedule|station|play listen live|follow us:|about & help|get the lbc app|legal & info|business & careers)$/i.test(candidate) ||
        /^(thu|fri|sat|sun|mon|tue|wed)(?:\s+(thu|fri|sat|sun|mon|tue|wed))*$/i.test(candidate) ||
        /^lbc(?:\s+lbc news)?(?:\s+chevron down)?$/i.test(candidate) ||
        /^see more$/i.test(candidate)
      ) {
        continue
      }

      title = candidate
      break
    }

    if (!title) continue

    entries.push({
      title,
      subtitle: '',
      description: 'Grade oficial da pagina de programacao da LBC.',
      timeLabel: line.toUpperCase().replace(/\s+/g, ' '),
      isLive: entries.length === 0,
    })
  }

  if (!entries.length) {
    throw new Error('Nao consegui ler a programacao oficial da LBC agora.')
  }

  return {
    providerLabel: 'LBC schedule oficial',
    now: entries[0],
    upcoming: entries.slice(1, 6),
    updatedAt: new Date().toISOString(),
  } satisfies RadioGuideSnapshot
}

function appendJsonpCallback(url: string, callbackName: string) {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}callback=${callbackName}`
}

async function fetchJsonpViaProxy<T>(url: string, callbackPrefix: string, proxyBase: string) {
  const callbackName = `iptvPagesHub_${callbackPrefix}`
  const response = await fetch(buildProxyUrl(proxyBase, appendJsonpCallback(url, callbackName)), {
    headers: {
      Accept: 'application/javascript, text/javascript, */*',
      'User-Agent': 'Mozilla/5.0',
    },
  })

  if (!response.ok) {
    throw new Error('A fonte oficial nao respondeu ao pedido da grade.')
  }

  const payload = (await response.text()).trim()
  const match = payload.match(/^[^(]+\(([\s\S]*)\)\s*;?\s*$/)

  if (!match) {
    throw new Error('A fonte oficial devolveu um formato de grade invalido.')
  }

  return JSON.parse(match[1]) as T
}

function normaliseTimesEntry(entry: TimesScheduleResult): RadioGuideEntry {
  return {
    title: normalizeText(entry.programmeName) || 'Programa ao vivo',
    subtitle: '',
    description: normalizeText(entry.programmeDescription),
    timeLabel: formatRangeFromEpoch(String(entry.startTime || ''), String(entry.stopTime || '')),
    imageUrl: normalizeText(entry.imageUrl) || undefined,
  }
}

async function loadTimesGuide(proxyBase: string) {
  const rpId = '521'
  const baseUrl = 'https://np.radioplayer.co.uk/qp/'
  const [eventsPayload, schedulePayload] = await Promise.all([
    fetchJsonpViaProxy<{ results?: TimesNowPlayingResult }>(`${baseUrl}v4/events/?rpId=${rpId}`, 'times_events', proxyBase),
    fetchJsonpViaProxy<{ results?: TimesScheduleResult[] }>(`${baseUrl}v4/schedule?rpId=${rpId}`, 'times_schedule', proxyBase),
  ])

  const scheduleEntries = Array.isArray(schedulePayload.results)
    ? schedulePayload.results.map(normaliseTimesEntry)
    : []

  const livePi = eventsPayload.results?.pi
  const now = livePi
    ? {
        title: normalizeText(livePi.programmeName) || 'Times Radio',
        subtitle: '',
        description: normalizeText(livePi.programmeDescription),
        timeLabel: formatRangeFromEpoch(String(livePi.startTime || ''), String(livePi.stopTime || '')),
        imageUrl: normalizeText(livePi.imageUrl) || undefined,
        isLive: true,
      } satisfies RadioGuideEntry
    : scheduleEntries[0] || null

  const upcoming = scheduleEntries
    .filter((entry) => entry.title !== now?.title || entry.timeLabel !== now?.timeLabel)
    .slice(0, 5)

  if (!now && !upcoming.length) {
    throw new Error('Nao consegui ler a grade oficial da Times Radio agora.')
  }

  return {
    providerLabel: 'Times Radio / Radioplayer oficial',
    now,
    upcoming,
    updatedAt: new Date().toISOString(),
  } satisfies RadioGuideSnapshot
}

function supportsOfficialGuide(station: RadioStation) {
  return station.source === 'BBC Sounds' || station.id === 'lbc-uk' || station.id === 'times-radio'
}

export function hasOfficialRadioGuide(station: RadioStation | null | undefined) {
  return Boolean(station && supportsOfficialGuide(station))
}

export async function loadRadioGuide(station: RadioStation, proxyBase: string) {
  const cached = radioGuideCache.get(station.id)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.snapshot
  }

  let snapshot: RadioGuideSnapshot

  if (station.source === 'BBC Sounds') {
    snapshot = await loadBbcGuide(station, proxyBase)
  } else if (station.id === 'lbc-uk') {
    snapshot = await loadLbcGuide(proxyBase)
  } else if (station.id === 'times-radio') {
    snapshot = await loadTimesGuide(proxyBase)
  } else {
    throw new Error('Essa radio ainda nao tem grade oficial ligada no app.')
  }

  radioGuideCache.set(station.id, {
    snapshot,
    expiresAt: Date.now() + GUIDE_CACHE_TTL_MS,
  })
  return snapshot
}
