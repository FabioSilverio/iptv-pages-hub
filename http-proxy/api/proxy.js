import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'

const execFileAsync = promisify(execFile)

function buildProxyUrl(proxyOrigin, targetUrl, customReferer, customOrigin, videoOnly = false) {
  let url = `${proxyOrigin}/api/proxy?url=${encodeURIComponent(targetUrl)}`
  if (customReferer) url += `&referer=${encodeURIComponent(customReferer)}`
  if (customOrigin) url += `&origin=${encodeURIComponent(customOrigin)}`
  if (videoOnly) url += '&videoOnly=1'
  return url
}

function buildVariantProxyUrl(proxyOrigin, targetUrl, customReferer, customOrigin, options = {}) {
  let url = buildProxyUrl(proxyOrigin, targetUrl, customReferer, customOrigin, options.videoOnly)
  if (options.transcode) url += '&transcode=1'
  return url
}

function rewriteManifest(rawManifest, targetUrl, proxyOrigin, customReferer, customOrigin, options = {}) {
  return rawManifest
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#EXTM3U') || trimmed.startsWith('#EXT-X-ENDLIST')) return line

      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uriValue) => {
          const absoluteUrl = new URL(uriValue, targetUrl).toString()
          return `URI="${buildVariantProxyUrl(proxyOrigin, absoluteUrl, customReferer, customOrigin, options)}"`
        })
      }

      const absoluteUrl = new URL(trimmed, targetUrl).toString()
      return buildVariantProxyUrl(proxyOrigin, absoluteUrl, customReferer, customOrigin, options)
    })
    .join('\n')
}

const crcTable = new Uint32Array(256)
for (let i = 0; i < 256; i += 1) {
  let value = i << 24
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 0x80000000) ? ((value << 1) ^ 0x04c11db7) : (value << 1)
  }
  crcTable[i] = value >>> 0
}

function crc32Mpeg(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 0xff]) >>> 0
  }
  return crc >>> 0
}

function parsePat(packet) {
  const payloadStart = Boolean(packet[1] & 0x40)
  const adaptation = (packet[3] >> 4) & 0x03
  if (!payloadStart || (adaptation !== 1 && adaptation !== 3)) return null

  let offset = 4
  if (adaptation === 3) offset += 1 + packet[offset]
  offset += packet[offset] + 1
  if (packet[offset] !== 0x00) return null

  const sectionLength = ((packet[offset + 1] & 0x0f) << 8) | packet[offset + 2]
  const sectionEnd = offset + 3 + sectionLength - 4
  for (let index = offset + 8; index + 3 < sectionEnd; index += 4) {
    const programNumber = (packet[index] << 8) | packet[index + 1]
    if (programNumber) return ((packet[index + 2] & 0x1f) << 8) | packet[index + 3]
  }
  return null
}

function parsePmt(packet, pmtPid) {
  const pid = ((packet[1] & 0x1f) << 8) | packet[2]
  const payloadStart = Boolean(packet[1] & 0x40)
  const adaptation = (packet[3] >> 4) & 0x03
  if (pid !== pmtPid || !payloadStart || (adaptation !== 1 && adaptation !== 3)) return null

  let offset = 4
  if (adaptation === 3) offset += 1 + packet[offset]
  offset += packet[offset] + 1
  if (packet[offset] !== 0x02) return null

  const sectionLength = ((packet[offset + 1] & 0x0f) << 8) | packet[offset + 2]
  const sectionEnd = offset + 3 + sectionLength - 4
  const programInfoLength = ((packet[offset + 10] & 0x0f) << 8) | packet[offset + 11]
  const audioPids = new Set()
  const videoPids = new Set()

  for (let index = offset + 12 + programInfoLength; index + 4 < sectionEnd;) {
    const streamType = packet[index]
    const streamPid = ((packet[index + 1] & 0x1f) << 8) | packet[index + 2]
    const esInfoLength = ((packet[index + 3] & 0x0f) << 8) | packet[index + 4]
    if ([0x1b, 0x24, 0x02, 0x10, 0xea].includes(streamType)) videoPids.add(streamPid)
    if ([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87].includes(streamType)) audioPids.add(streamPid)
    index += 5 + esInfoLength
  }

  return { audioPids, videoPids }
}

function rewritePmtVideoOnly(packet, pmtPid, videoPids) {
  const pid = ((packet[1] & 0x1f) << 8) | packet[2]
  const payloadStart = Boolean(packet[1] & 0x40)
  const adaptation = (packet[3] >> 4) & 0x03
  if (pid !== pmtPid || !payloadStart || !videoPids.size || (adaptation !== 1 && adaptation !== 3)) return packet

  let payloadOffset = 4
  if (adaptation === 3) payloadOffset += 1 + packet[payloadOffset]
  const pointerOffset = payloadOffset
  const sectionOffset = pointerOffset + packet[pointerOffset] + 1
  if (packet[sectionOffset] !== 0x02) return packet

  const programInfoLength = ((packet[sectionOffset + 10] & 0x0f) << 8) | packet[sectionOffset + 11]
  const sectionLength = ((packet[sectionOffset + 1] & 0x0f) << 8) | packet[sectionOffset + 2]
  const sectionEnd = sectionOffset + 3 + sectionLength - 4
  const section = []
  for (let index = sectionOffset; index < sectionOffset + 12 + programInfoLength; index += 1) section.push(packet[index])

  let pcrPid = null
  for (let index = sectionOffset + 12 + programInfoLength; index + 4 < sectionEnd;) {
    const streamPid = ((packet[index + 1] & 0x1f) << 8) | packet[index + 2]
    const esInfoLength = ((packet[index + 3] & 0x0f) << 8) | packet[index + 4]
    if (videoPids.has(streamPid)) {
      if (pcrPid === null) pcrPid = streamPid
      for (let cursor = index; cursor < index + 5 + esInfoLength; cursor += 1) section.push(packet[cursor])
    }
    index += 5 + esInfoLength
  }

  if (pcrPid !== null) {
    section[8] = (section[8] & 0xe0) | ((pcrPid >> 8) & 0x1f)
    section[9] = pcrPid & 0xff
  }

  const newSectionLength = section.length - 3 + 4
  section[1] = (section[1] & 0xf0) | ((newSectionLength >> 8) & 0x0f)
  section[2] = newSectionLength & 0xff
  const crc = crc32Mpeg(section)
  section.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff)

  const nextPacket = Buffer.alloc(188, 0xff)
  packet.copy(nextPacket, 0, 0, payloadOffset)
  nextPacket[pointerOffset] = packet[pointerOffset]
  Buffer.from(section).copy(nextPacket, sectionOffset)
  return nextPacket
}

function stripAudioFromTs(buffer) {
  if (buffer.length < 188) return buffer
  let pmtPid = null
  let audioPids = new Set()
  let videoPids = new Set()

  for (let offset = 0; offset + 188 <= buffer.length; offset += 188) {
    const packet = buffer.subarray(offset, offset + 188)
    if (packet[0] !== 0x47) continue
    const pid = ((packet[1] & 0x1f) << 8) | packet[2]
    if (pid === 0) pmtPid = parsePat(packet) ?? pmtPid
    if (pmtPid !== null && pid === pmtPid) {
      const parsed = parsePmt(packet, pmtPid)
      if (parsed) {
        audioPids = parsed.audioPids
        videoPids = parsed.videoPids
        break
      }
    }
  }

  if (!audioPids.size || !videoPids.size || pmtPid === null) return buffer

  const packets = []
  for (let offset = 0; offset + 188 <= buffer.length; offset += 188) {
    const packet = buffer.subarray(offset, offset + 188)
    if (packet[0] !== 0x47) continue
    const pid = ((packet[1] & 0x1f) << 8) | packet[2]
    if (audioPids.has(pid)) continue
    packets.push(pid === pmtPid ? rewritePmtVideoOnly(packet, pmtPid, videoPids) : packet)
  }

  return Buffer.concat(packets)
}

async function transcodeTsSegment(source) {
  if (!ffmpegPath) {
    throw new Error('FFmpeg binary is not available in this deployment.')
  }

  const id = randomUUID()
  const inputPath = path.join(os.tmpdir(), `${id}.ts`)
  const outputPath = path.join(os.tmpdir(), `${id}.out.ts`)

  try {
    await fs.writeFile(inputPath, source)
    await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-map',
      '0:v:0',
      '-an',
      '-vf',
      'yadif=0:-1:0',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-profile:v',
      'main',
      '-level',
      '4.0',
      '-pix_fmt',
      'yuv420p',
      '-f',
      'mpegts',
      outputPath,
    ], { timeout: 25_000, maxBuffer: 1024 * 1024 })
    return await fs.readFile(outputPath)
  } finally {
    await Promise.allSettled([
      fs.unlink(inputPath),
      fs.unlink(outputPath),
    ])
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '*'
  const corsHeaders = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin',
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders)
    res.end()
    return
  }

  const target = String(req.query.url || '').trim()
  const customReferer = req.query.referer || ''
  const customOrigin = req.query.origin || ''
  const videoOnly = req.query.videoOnly === '1'
  const transcode = req.query.transcode === '1'
  if (!target) {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Missing url query param.' }))
    return
  }

  let targetUrl
  try {
    targetUrl = new URL(target)
  } catch {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid target URL.' }))
    return
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Only http and https are supported.' }))
    return
  }

  try {
    const upstream = await fetchUpstream(req, targetUrl, customReferer, customOrigin)

    const contentType = upstream.headers.get('content-type') || ''
    const proto = req.headers['x-forwarded-proto'] || 'https'
    const host = req.headers['x-forwarded-host'] || req.headers.host
    const proxyOrigin = `${proto}://${host}`

    const isManifest =
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegurl') ||
      targetUrl.pathname.endsWith('.m3u8')

    if (isManifest) {
      const rawManifest = await upstream.text()
      const manifestBaseUrl = new URL(upstream.url || targetUrl.toString())
      const manifest = rewriteManifest(rawManifest, manifestBaseUrl, proxyOrigin, customReferer, customOrigin, {
        videoOnly,
        transcode,
      })
      res.writeHead(upstream.status, {
        ...corsHeaders,
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
      })
      res.end(manifest)
      return
    }

    const isTransportStream =
      (videoOnly || transcode) &&
      (contentType.includes('video/mp2t') || contentType.includes('application/octet-stream') || targetUrl.pathname.endsWith('.ts'))

    if (isTransportStream && req.method !== 'HEAD') {
      const source = Buffer.from(await upstream.arrayBuffer())
      const filtered = transcode ? await transcodeTsSegment(source) : stripAudioFromTs(source)
      res.writeHead(upstream.status, {
        ...corsHeaders,
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'no-store',
        'Content-Length': String(filtered.length),
      })
      res.end(filtered)
      return
    }

    res.writeHead(upstream.status, {
      ...corsHeaders,
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    if (req.method === 'HEAD' || !upstream.body) {
      res.end()
      return
    }

    for await (const chunk of upstream.body) {
      res.write(chunk)
    }
    res.end()
  } catch (error) {
    res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Proxy failure.' }))
  }
}

async function fetchUpstream(req, targetUrl, customReferer, customOrigin) {
  const headers = {
    Accept: req.headers.accept || '*/*',
    'Accept-Encoding': 'identity',
    'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
    ...(customReferer ? { Referer: customReferer } : {}),
    ...(customOrigin ? { Origin: customOrigin } : {}),
  }

  if (req.headers.range) {
    headers.Range = req.headers.range
  }

  const firstResponse = await fetch(targetUrl.toString(), {
    method: req.method === 'HEAD' ? 'GET' : 'GET',
    headers,
    redirect: 'manual',
  })

  if (![301, 302, 303, 307, 308].includes(firstResponse.status)) {
    return firstResponse
  }

  const location = firstResponse.headers.get('location')
  if (!location) {
    return firstResponse
  }

  const redirectUrl = new URL(location, targetUrl)
  return fetch(redirectUrl.toString(), {
    method: 'GET',
    headers,
    redirect: 'manual',
  })
}
