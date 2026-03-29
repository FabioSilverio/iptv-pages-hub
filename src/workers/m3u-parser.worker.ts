import { createChannelId, normalizeGroupName, safeChannelName, type Channel } from '../lib/iptv'

interface PendingChannel {
  name: string
  group: string
  logo?: string
  tvgId?: string
}

function parseAttributes(raw: string) {
  const attributes: Record<string, string> = {}
  const matcher = /([\w-]+)="([^"]*)"/g

  for (const match of raw.matchAll(matcher)) {
    attributes[match[1]] = match[2]
  }

  return attributes
}

function parseM3U(rawText: string) {
  const channels: Channel[] = []
  const lines = rawText.split(/\r?\n/)
  let pending: PendingChannel | null = null

  for (const line of lines) {
    const currentLine = line.trim()

    if (!currentLine) {
      continue
    }

    if (currentLine.startsWith('#EXTINF:')) {
      const commaIndex = currentLine.indexOf(',')
      const header = commaIndex >= 0 ? currentLine.slice(0, commaIndex) : currentLine
      const displayName = commaIndex >= 0 ? currentLine.slice(commaIndex + 1).trim() : ''
      const attributes = parseAttributes(header)

      pending = {
        name: safeChannelName(attributes['tvg-name'] || displayName),
        group: normalizeGroupName(attributes['group-title']),
        logo: attributes['tvg-logo'] || undefined,
        tvgId: attributes['tvg-id'] || undefined,
      }
      continue
    }

    if (currentLine.startsWith('#EXTGRP:') && pending) {
      pending.group = normalizeGroupName(currentLine.replace('#EXTGRP:', '').trim())
      continue
    }

    if (currentLine.startsWith('#')) {
      continue
    }

    if (!pending) {
      pending = {
        name: safeChannelName(currentLine),
        group: normalizeGroupName(),
      }
    }

    channels.push({
      id: createChannelId('m3u', `${pending.tvgId || pending.name}:${currentLine}`),
      name: pending.name,
      group: pending.group,
      streamUrl: currentLine,
      logo: pending.logo,
      tvgId: pending.tvgId,
    })

    pending = null
  }

  return channels
}

self.onmessage = (event: MessageEvent<string>) => {
  const channels = parseM3U(event.data)
  self.postMessage(channels)
}
