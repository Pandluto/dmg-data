import {
  createSitesMobileShareHandler,
  type SitesMobileShareRepository,
} from './mobileShareApi'

const RETIREMENT_TARGET = 'https://dmgendfield.cloud'
const RETIRED_VERSION = {
  schemaVersion: 1,
  releaseVersion: '1.8.5-retired',
  shellVersion: '3bbac54d4a3c4308',
} as const

type SitesWorkerEnvironment = {
  MOBILE_SHARE_REPOSITORY?: SitesMobileShareRepository
}

function isMobileShareApi(pathname: string): boolean {
  return pathname === '/api/mobile-shares'
    || pathname === '/api/mobile-shares/health'
    || /^\/api\/mobile-shares\/[A-Za-z0-9_-]{16}$/.test(pathname)
}

function noStoreHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra)
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  return headers
}

function retiredServiceWorker(): Response {
  const source = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const name of await caches.keys()) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  const source = new URL(event.request.url);
  event.respondWith(Response.redirect('https://dmgendfield.cloud' + source.pathname + source.search, 308));
});
`
  return new Response(source.trimStart(), {
    status: 200,
    headers: noStoreHeaders({
      'Content-Type': 'text/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/',
    }),
  })
}

async function routeMobileShare(request: Request, env: SitesWorkerEnvironment): Promise<Response> {
  if (request.method === 'OPTIONS') {
    const inertRepository = {} as SitesMobileShareRepository
    return createSitesMobileShareHandler(inertRepository)(request)
  }
  if (!env.MOBILE_SHARE_REPOSITORY) {
    return new Response(JSON.stringify({
      code: 'SHARE_STORE_UNAVAILABLE',
      message: '分享存储尚未连接。',
    }), {
      status: 503,
      headers: noStoreHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
    })
  }
  return createSitesMobileShareHandler(env.MOBILE_SHARE_REPOSITORY)(request)
}

const sitesWorker = {
  async fetch(request: Request, env: SitesWorkerEnvironment): Promise<Response> {
    const source = new URL(request.url)
    if (isMobileShareApi(source.pathname)) return routeMobileShare(request, env)

    if (request.method === 'GET' && source.pathname === '/version.json') {
      return new Response(JSON.stringify(RETIRED_VERSION), {
        status: 200,
        headers: noStoreHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
      })
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && source.pathname === '/sw.js') {
      const response = retiredServiceWorker()
      return request.method === 'HEAD' ? new Response(null, response) : response
    }

    const location = `${RETIREMENT_TARGET}${source.pathname}${source.search}`
    return new Response(null, {
      status: 308,
      headers: noStoreHeaders({
        Location: location,
        'X-DMG-Site-Status': 'retired',
      }),
    })
  },
}

export default sitesWorker
