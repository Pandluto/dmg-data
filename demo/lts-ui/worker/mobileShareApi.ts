const RATE_WINDOW_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://dmgendfield.cloud',
  'https://dmgendfield.online',
  'https://150.158.133.176',
  'http://150.158.133.176',
  'http://127.0.0.1:3030',
  'http://localhost:3030',
  'http://127.0.0.1:31457',
  'http://localhost:31457',
])
const DEVICE_COOKIE = 'dmg_share_device'
const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/
const DEVICE_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface SitesMobileShareMetadata {
  id: string
  createdAt: number
  expiresAt: null
  permanent: true
  payloadHash: string
  payloadBytes: number
  ipHash: string
}

export interface SitesMobileShareCreationEvent {
  ipHash: string
  deviceHash: string
  createdAt: number
}

export interface SitesMobileShareRecord {
  id: string
  createdAt: number
  expiresAt: null
  permanent: true
  payload: unknown
}

export interface SitesMobileShareRepository {
  ensureReady(): Promise<void>
  getOrCreateSecret(key: string): Promise<string>
  deleteRateEventsBefore(timestamp: number): Promise<void>
  findByPayloadHash(payloadHash: string): Promise<SitesMobileShareMetadata | null>
  countRateEvents(
    windowStart: number,
    ipHash: string,
    deviceHash: string,
  ): Promise<{ device: number; ip: number; global: number }>
  create(
    metadata: SitesMobileShareMetadata,
    serializedPayload: string,
    event: SitesMobileShareCreationEvent,
  ): Promise<
    | { status: 'created' | 'reused'; metadata: SitesMobileShareMetadata }
    | { status: 'id-conflict' }
  >
  get(id: string): Promise<SitesMobileShareRecord | null>
  stats(windowStart: number): Promise<{ permanent: number; createdLast24Hours: number }>
}

export interface SitesMobileShareHandlerOptions {
  now?: () => number
  rateWindowMs?: number
  perDeviceLimit?: number
  perIpLimit?: number
  globalLimit?: number
  maxPayloadBytes?: number
  allowedOrigins?: readonly string[]
}

class ShareApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function json(status: number, value: unknown, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  })
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach((value) => { binary += String.fromCharCode(value) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomToken(byteLength: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function signDevice(deviceId: string, secretHex: string): Promise<string> {
  const secret = Uint8Array.from(secretHex.match(/.{1,2}/g) ?? [], (part) => Number.parseInt(part, 16))
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(deviceId))
  return bytesToBase64Url(new Uint8Array(signature))
}

function readCookie(request: Request, name: string): string {
  const cookieHeader = request.headers.get('Cookie') ?? ''
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      return ''
    }
  }
  return ''
}

async function resolveDevice(request: Request, deviceSecret: string): Promise<{ id: string; token: string }> {
  const token = readCookie(request, DEVICE_COOKIE)
  const [candidateId, candidateSignature, extra] = token.split('.')
  if (
    extra === undefined
    && DEVICE_ID_PATTERN.test(candidateId ?? '')
    && DEVICE_SIGNATURE_PATTERN.test(candidateSignature ?? '')
    && await signDevice(candidateId, deviceSecret) === candidateSignature
  ) {
    return { id: candidateId, token }
  }
  const id = randomToken(16)
  return { id, token: `${id}.${await signDevice(id, deviceSecret)}` }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validatePayload(payload: unknown): asserts payload is Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new ShareApiError(400, 'INVALID_SHARE', '分享数据格式不正确。')
  }
  const draft = payload.draft
  if (
    payload.schemaVersion !== 1
    && !(payload.schemaVersion === 2 && payload.source === 'mobile')
  ) {
    throw new ShareApiError(400, 'INVALID_SHARE', '分享来源或版本不受支持。')
  }
  if (
    !isRecord(draft)
    || draft.schemaVersion !== 1
    || !Array.isArray(draft.selectedOperatorIds)
    || draft.selectedOperatorIds.length > 4
    || !isRecord(draft.operatorConfigs)
    || !Array.isArray(draft.slots)
    || draft.slots.length > 128
    || !isRecord(draft.reportNotes ?? {})
  ) {
    throw new ShareApiError(400, 'INVALID_DRAFT', '工作区快照格式不正确。')
  }
  if (
    typeof payload.dataVersion !== 'string'
    || payload.dataVersion.length > 80
    || typeof payload.imageVersion !== 'string'
    || payload.imageVersion.length > 80
  ) {
    throw new ShareApiError(400, 'INVALID_VERSION', '分享版本信息不正确。')
  }
}

function corsHeaders(request: Request, allowedOrigins: ReadonlySet<string>): HeadersInit {
  const origin = (request.headers.get('Origin') ?? '').replace(/\/$/, '')
  if (!origin) return {}
  if (!allowedOrigins.has(origin)) {
    throw new ShareApiError(403, 'ORIGIN_NOT_ALLOWED', '当前网页来源不能访问分享服务。')
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
}

export function createSitesMobileShareHandler(
  repository: SitesMobileShareRepository,
  options: SitesMobileShareHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const now = options.now ?? (() => Date.now())
  const rateWindowMs = options.rateWindowMs ?? RATE_WINDOW_MS
  const perDeviceLimit = options.perDeviceLimit ?? 3
  const perIpLimit = options.perIpLimit ?? 10
  const globalLimit = options.globalLimit ?? 100
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES
  const allowedOrigins = new Set(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS)

  return async (request: Request): Promise<Response> => {
    let cors: HeadersInit = {}
    try {
      cors = corsHeaders(request, allowedOrigins)
      const url = new URL(request.url)
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })

      await repository.ensureReady()
      const timestamp = now()
      const windowStart = timestamp - rateWindowMs

      if (request.method === 'GET' && url.pathname === '/api/mobile-shares/health') {
        const stats = await repository.stats(windowStart)
        return json(200, { ok: true, active: stats.permanent, ...stats }, cors)
      }

      if (request.method === 'POST' && url.pathname === '/api/mobile-shares') {
        if ((request.headers.get('Content-Type') ?? '').split(';')[0].trim() !== 'application/json') {
          throw new ShareApiError(415, 'JSON_REQUIRED', '分享接口只接受 JSON。')
        }
        const serialized = await request.text()
        const payloadBytes = new TextEncoder().encode(serialized).byteLength
        if (payloadBytes > maxPayloadBytes) {
          throw new ShareApiError(413, 'PAYLOAD_TOO_LARGE', '分享内容过大，请减少排轴项目后重试。')
        }
        let payload: unknown
        try {
          payload = JSON.parse(serialized)
        } catch {
          throw new ShareApiError(400, 'INVALID_JSON', '分享请求不是有效的 JSON。')
        }
        validatePayload(payload)

        const identitySalt = await repository.getOrCreateSecret('identity_salt')
        const deviceSecret = await repository.getOrCreateSecret('device_secret')
        const device = await resolveDevice(request, deviceSecret)
        const ipAddress = request.headers.get('CF-Connecting-IP') ?? 'unknown'
        const [payloadHash, ipHash, deviceHash] = await Promise.all([
          sha256(serialized),
          sha256(`${identitySalt}:${ipAddress}`),
          sha256(`${identitySalt}:device:${device.id}`),
        ])
        await repository.deleteRateEventsBefore(windowStart)
        const existing = await repository.findByPayloadHash(payloadHash)
        const secure = url.protocol === 'https:' ? '; Secure' : ''
        const cookie = `${DEVICE_COOKIE}=${encodeURIComponent(device.token)}; Path=/api/mobile-shares; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`
        if (existing) {
          return json(200, {
            id: existing.id,
            createdAt: existing.createdAt,
            expiresAt: null,
            permanent: true,
            reused: true,
          }, { ...cors, 'Set-Cookie': cookie })
        }

        const counts = await repository.countRateEvents(windowStart, ipHash, deviceHash)
        if (counts.device >= perDeviceLimit) {
          throw new ShareApiError(429, 'DEVICE_DAILY_LIMIT', `当前浏览器 24 小时内最多创建 ${perDeviceLimit} 份永久分享。`)
        }
        if (counts.ip >= perIpLimit) {
          throw new ShareApiError(429, 'IP_DAILY_LIMIT', `当前网络 24 小时内最多创建 ${perIpLimit} 份永久分享。`)
        }
        if (counts.global >= globalLimit) {
          throw new ShareApiError(429, 'DAILY_LIMIT', `服务器 24 小时内最多创建 ${globalLimit} 份永久分享，请稍后再试。`)
        }

        for (let attempt = 0; attempt < 4; attempt += 1) {
          const metadata: SitesMobileShareMetadata = {
            id: randomToken(12),
            createdAt: timestamp,
            expiresAt: null,
            permanent: true,
            payloadHash,
            payloadBytes,
            ipHash,
          }
          const result = await repository.create(metadata, serialized, { ipHash, deviceHash, createdAt: timestamp })
          if (result.status === 'id-conflict') continue
          return json(result.status === 'created' ? 201 : 200, {
            id: result.metadata.id,
            createdAt: result.metadata.createdAt,
            expiresAt: null,
            permanent: true,
            reused: result.status === 'reused',
          }, { ...cors, 'Set-Cookie': cookie })
        }
        throw new ShareApiError(500, 'ID_ALLOCATION_FAILED', '无法分配分享编号。')
      }

      const match = url.pathname.match(/^\/api\/mobile-shares\/([A-Za-z0-9_-]{16})$/)
      if (request.method === 'GET' && match && SHARE_ID_PATTERN.test(match[1])) {
        const record = await repository.get(match[1])
        if (!record) throw new ShareApiError(404, 'SHARE_NOT_FOUND', '分享不存在。')
        return json(200, record, cors)
      }
      throw new ShareApiError(404, 'NOT_FOUND', '分享接口不存在。')
    } catch (error) {
      if (error instanceof ShareApiError) {
        return json(error.status, { code: error.code, message: error.message }, cors)
      }
      return json(500, { code: 'INTERNAL_ERROR', message: '分享服务暂时不可用。' }, cors)
    }
  }
}
