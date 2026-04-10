#!/usr/bin/env node

import { createSocket as createDgramSocket } from 'dgram'
import * as net from 'net'
import { WebSocketServer } from 'ws'
import Bonjour from 'bonjour-service'

const PROXY_PORT = parseInt(process.env.NOVA_PROXY_PORT || '3100', 10)
const SSDP_MULTICAST_ADDR = '239.255.255.250'
const SSDP_PORT = 1900
const SSDP_URN_OPENAPI = 'urn:openlaunch:service:openapi:1'
const SSDP_URN_WEBSOCKET = 'urn:openlaunch:service:websocket:1'
const MDNS_TYPE_OPENAPI = 'openapi-nova'
const MDNS_TYPE_WEBSOCKET = 'openlaunch-ws'
const DISCOVERY_TIMEOUT_MS = 5000

const MPH_TO_MS = 0.44704

function discoverNovaSSDP() {
  return new Promise((resolve, reject) => {
    console.log('[SSDP] Searching for Nova via SSDP...')

    const socket = createDgramSocket({ type: 'udp4', reuseAddr: true })
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      try { socket.close() } catch {}
      if (result) {
        resolve(result)
      } else {
        reject(new Error('SSDP discovery failed'))
      }
    }

    socket.on('message', (msg, rinfo) => {
      const response = msg.toString('utf-8')

      if (response.includes(SSDP_URN_OPENAPI) || response.includes(SSDP_URN_WEBSOCKET)) {
        console.log(`[SSDP] Response from ${rinfo.address}`)

        const headers = {}
        response.split('\r\n').forEach((line) => {
          if (line.includes(':')) {
            const idx = line.indexOf(':')
            const key = line.substring(0, idx).trim().toUpperCase()
            const value = line.substring(idx + 1).trim()
            headers[key] = value
          }
        })

        const location = headers['LOCATION'] || ''
        const cleaned = location
          .replace('http://', '')
          .replace('ws://', '')
          .replace(/\/$/, '')

        if (cleaned.includes(':')) {
          const colonIdx = cleaned.lastIndexOf(':')
          const host = cleaned.substring(0, colonIdx)
          const port = parseInt(cleaned.substring(colonIdx + 1), 10)

          const isWebSocket = response.includes(SSDP_URN_WEBSOCKET)
          console.log(`[SSDP] Found Nova ${isWebSocket ? 'WebSocket' : 'OpenAPI'} at ${host}:${port}`)
          finish({ host, port, protocol: isWebSocket ? 'websocket' : 'openapi' })
        }
      }
    })

    socket.on('error', (err) => {
      console.error('[SSDP] Socket error:', err.message)
      finish(null)
    })

    socket.bind(() => {
      const search =
        'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${SSDP_MULTICAST_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 3\r\n' +
        `ST: ${SSDP_URN_OPENAPI}\r\n` +
        '\r\n'

      socket.send(Buffer.from(search), SSDP_PORT, SSDP_MULTICAST_ADDR, (err) => {
        if (err) {
          console.error('[SSDP] Failed to send M-SEARCH:', err.message)
          finish(null)
        } else {
          console.log('[SSDP] Sent M-SEARCH')
        }
      })

      setTimeout(() => {
        console.log('[SSDP] Timeout')
        finish(null)
      }, DISCOVERY_TIMEOUT_MS)
    })
  })
}

function discoverNovaMDNS() {
  return new Promise((resolve, reject) => {
    console.log('[mDNS] Searching for Nova via mDNS...')

    const bonjour = new Bonjour()
    let settled = false

    const finish = (result) => {
      if (settled) return
      settled = true
      try { browser.stop() } catch {}
      try { bonjour.destroy() } catch {}
      if (result) {
        resolve(result)
      } else {
        reject(new Error('mDNS discovery failed'))
      }
    }

    const browser = bonjour.find({ type: MDNS_TYPE_OPENAPI }, (service) => {
      console.log(`[mDNS] Found Nova OpenAPI at ${service.referer.address}:${service.port}`)
      finish({
        host: service.referer.address,
        port: service.port,
        protocol: 'openapi',
      })
    })

    setTimeout(() => {
      console.log('[mDNS] Timeout, trying WebSocket service type...')

      if (settled) return
      try { browser.stop() } catch {}

      const wsBrowser = bonjour.find({ type: MDNS_TYPE_WEBSOCKET }, (service) => {
        console.log(`[mDNS] Found Nova WebSocket at ${service.referer.address}:${service.port}`)
        settled = true
        try { wsBrowser.stop() } catch {}
        try { bonjour.destroy() } catch {}
        resolve({
          host: service.referer.address,
          port: service.port,
          protocol: 'websocket',
        })
      })

      setTimeout(() => {
        if (settled) return
        try { wsBrowser.stop() } catch {}
        try { bonjour.destroy() } catch {}
        console.log('[mDNS] No services found')
        finish(null)
      }, DISCOVERY_TIMEOUT_MS)
    }, DISCOVERY_TIMEOUT_MS)
  })
}

async function discoverNova() {
  try {
    return await discoverNovaSSDP()
  } catch {
    console.log('[Discovery] SSDP failed, falling back to mDNS...')
  }

  try {
    return await discoverNovaMDNS()
  } catch {
    throw new Error('Nova not found via SSDP or mDNS')
  }
}

function connectOpenAPI(host, port, onShot) {
  console.log(`[OpenAPI] Connecting to ${host}:${port}...`)

  const socket = new net.Socket()
  let buffer = ''

  socket.connect(port, host, () => {
    console.log(`[OpenAPI] Connected to ${host}:${port}`)
  })

  socket.on('data', (data) => {
    buffer += data.toString('utf-8')

    while (buffer.includes('\n')) {
      const idx = buffer.indexOf('\n')
      const line = buffer.substring(0, idx).trim()
      buffer = buffer.substring(idx + 1)

      if (line) {
        try {
          const parsed = JSON.parse(line)

          if (parsed.BallData) {
            const wsMessage = {
              type: 'shot',
              shot_number: parsed.ShotNumber,
              ball_speed_meters_per_second: (parsed.BallData.Speed ?? 0) * MPH_TO_MS,
              vertical_launch_angle_degrees: parsed.BallData.VLA,
              horizontal_launch_angle_degrees: parsed.BallData.HLA,
              total_spin_rpm: parsed.BallData.TotalSpin,
              spin_axis_degrees: parsed.BallData.SpinAxis,
              back_spin_rpm: parsed.BallData.BackSpin,
              side_spin_rpm: parsed.BallData.SideSpin,
            }
            onShot(wsMessage)
          } else {
            onShot(parsed)
          }
        } catch {
          console.error('[OpenAPI] Failed to parse:', line)
        }
      }
    }
  })

  socket.on('error', (err) => {
    console.error('[OpenAPI] Connection error:', err.message)
  })

  socket.on('close', () => {
    console.log('[OpenAPI] Connection closed')
  })

  return socket
}

function connectWebSocket(host, port, onShot) {
  const wsUrl = `ws://${host}:${port}`
  console.log(`[WebSocket] Connecting to ${wsUrl}...`)

  const ws = new WebSocket(wsUrl)

  ws.addEventListener('open', () => {
    console.log(`[WebSocket] Connected to ${wsUrl}`)
  })

  ws.addEventListener('message', (event) => {
    try {
      const parsed = JSON.parse(event.data)

      if (parsed.type === 'shot') {
        onShot(parsed)
      } else if (parsed.type === 'status') {
        onShot(parsed)
      }
    } catch {
      console.error('[WebSocket] Failed to parse:', event.data)
    }
  })

  ws.addEventListener('error', (event) => {
    console.error('[WebSocket] Error')
  })

  ws.addEventListener('close', () => {
    console.log('[WebSocket] Connection closed')
  })

  return ws
}

async function main() {
  console.log('=== Nova Discovery Proxy ===')
  console.log(`Proxy WebSocket port: ${PROXY_PORT}`)
  console.log()

  const discovered = await discoverNova()

  console.log()
  console.log(`Discovered Nova ${discovered.protocol} at ${discovered.host}:${discovered.port}`)

  const wss = new WebSocketServer({ port: PROXY_PORT })
  console.log(`Proxy listening on ws://localhost:${PROXY_PORT}`)
  console.log('Start the browser app with: VITE_NOVA_WS_URL=ws://localhost:' + PROXY_PORT + ' npm run dev')
  console.log()

  let upstream = null

  wss.on('connection', (ws) => {
    console.log('[Proxy] Browser client connected')

    const onShot = (data) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(data))
      }
    }

    if (discovered.protocol === 'openapi') {
      upstream = connectOpenAPI(discovered.host, discovered.port, onShot)
    } else {
      upstream = connectWebSocket(discovered.host, discovered.port, onShot)
    }

    ws.on('close', () => {
      console.log('[Proxy] Browser client disconnected')
      if (upstream) {
        if (upstream instanceof net.Socket) {
          upstream.destroy()
        } else if (upstream.close) {
          upstream.close()
        }
        upstream = null
      }
    })
  })

  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    if (upstream) {
      if (upstream instanceof net.Socket) {
        upstream.destroy()
      } else if (upstream.close) {
        upstream.close()
      }
    }
    wss.close()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('Fatal:', err.message)
  console.error()
  console.error('Make sure your Nova device is powered on and on the same network.')
  console.error('You can also set VITE_NOVA_WS_URL manually to skip discovery.')
  process.exit(1)
})
