# Sprint 1 — Worker scaffolding

**Cél:** Üres Worker fut, fogadja a POST-okat, válaszol 204-gyel. KV-k és R2 bekötve, de még semmilyen tényleges integráció nincs.

**Idő Claude Code-dal:** 2-3 óra.

## Mielőtt nekiállsz

Csináld meg a `00-pre-sprint-setup.md` checklist-et. Minden ✅ kell legyen.

## Project struktura

```
.
├── package.json
├── wrangler.toml
├── tsconfig.json
├── README.md
├── CLAUDE.md          # Másold át a fő CLAUDE.md-t
├── .gitignore
├── src/
│   ├── worker.ts
│   ├── env.ts
│   ├── types.ts
│   ├── routes/
│   │   ├── conversion.ts
│   │   └── health.ts
│   └── lib/
│       └── (üres, jönnek a következő sprintekben)
└── tests/
    └── (üres)
```

## `package.json`

```json
{
  "name": "soborbo-tracking-worker",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "deploy:staging": "wrangler deploy --env staging",
    "tail": "wrangler tail",
    "types": "wrangler types"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260101.0",
    "typescript": "^5.4.0",
    "wrangler": "^3.50.0"
  }
}
```

(A pontos verziókat ellenőrizd `npm view <package> version`-nel.)

## `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules"]
}
```

## `wrangler.toml`

```toml
name = "soborbo-tracking"
main = "src/worker.ts"
compatibility_date = "2026-04-01"
compatibility_flags = ["nodejs_compat"]

[observability]
enabled = true
head_sampling_rate = 1.0

# KV namespaces
[[kv_namespaces]]
binding = "SITE_CONFIG"
id = "<TODO_SITE_CONFIG_KV_ID>"

[[kv_namespaces]]
binding = "OAUTH_TOKENS"
id = "<TODO_OAUTH_TOKENS_KV_ID>"

# R2 bucket
[[r2_buckets]]
binding = "DEAD_LETTER"
bucket_name = "soborbo-tracking-dlq"

# Routes — Sprint 1-ben CSAK Painless route, többi Sprint 10-ben jön
[[routes]]
pattern = "painlessremovals.com/api/event/*"
zone_name = "painlessremovals.com"
```

JEGYZET Claude Code-nak: a `<TODO_*_KV_ID>` placeholder-eket KÉRDEZD a usertől, ne találj ki ID-ket.

## `src/env.ts`

```typescript
export interface Env {
  // KV namespaces
  SITE_CONFIG: KVNamespace;
  OAUTH_TOKENS: KVNamespace;

  // R2 buckets
  DEAD_LETTER: R2Bucket;

  // Secrets (set via `wrangler secret put`)
  // Sprint 1-ben még nincs egy sem, de placeholder-ben deklaráljuk a következőkre:
  // TURNSTILE_SECRET_KEY: string;
  // GADS_OAUTH_CLIENT_ID: string;
  // GADS_OAUTH_CLIENT_SECRET: string;
}
```

## `src/types.ts`

```typescript
export type StructuredLog = {
  level: 'info' | 'warn' | 'error';
  message: string;
  hostname?: string;
  event_name?: string;
  site_id?: string;
  duration_ms?: number;
  error?: string;
  [key: string]: unknown;
};

export function logStructured(log: StructuredLog): void {
  const fn = log.level === 'error' ? console.error : log.level === 'warn' ? console.warn : console.log;
  fn(JSON.stringify(log));
}
```

## `src/worker.ts`

```typescript
import type { Env } from './env';
import { handleConversion } from './routes/conversion';
import { handleHealth } from './routes/health';
import { logStructured } from './types';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/api/event/health') {
        return handleHealth(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/event/conversion') {
        return handleConversion(request, env, ctx);
      }

      // CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(request)
        });
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      logStructured({
        level: 'error',
        message: 'Unhandled exception in fetch handler',
        hostname: url.hostname,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - startedAt
      });
      return new Response(null, { status: 204 });
    }
  }
};

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

export { corsHeaders };
```

## `src/routes/health.ts`

```typescript
import type { Env } from '../env';

export async function handleHealth(_request: Request, _env: Env): Promise<Response> {
  return new Response(
    JSON.stringify({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '0.1.0'
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  );
}
```

## `src/routes/conversion.ts`

```typescript
import type { Env } from '../env';
import { logStructured } from '../types';
import { corsHeaders } from '../worker';

export async function handleConversion(
  request: Request,
  _env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const hostname = url.hostname;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    logStructured({
      level: 'warn',
      message: 'Invalid JSON in conversion request',
      hostname
    });
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  // Sprint 1: csak loggolunk, semmi tényleges feldolgozás
  logStructured({
    level: 'info',
    message: 'Conversion event received (Sprint 1 — placeholder)',
    hostname,
    event_name: typeof payload === 'object' && payload !== null && 'event_name' in payload
      ? String((payload as Record<string, unknown>).event_name)
      : 'unknown',
    duration_ms: Date.now() - startedAt
  });

  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
```

## `.gitignore`

```
node_modules/
dist/
.wrangler/
.env
.env.local
.dev.vars
*.log
.DS_Store
```

## Manuális tesztelési lépések

A user fogja végigmenni ezen a checklist-en. Ne csinálj automatizált teszteket Sprint 1-ben.

### Local dev

```bash
npm install
npm run types       # Wrangler types generate
npx tsc --noEmit    # TypeScript type check
npm run dev         # Local dev server, port 8787
```

Külön terminálban:

**A. Health check**
```bash
curl http://localhost:8787/api/event/health
```
→ `200 OK`, JSON `{"status":"ok",...}`

**B. POST conversion endpoint**
```bash
curl -X POST http://localhost:8787/api/event/conversion \
  -H "Content-Type: application/json" \
  -d '{"event_name":"test"}'
```
→ `204 No Content`
→ Wrangler tail-ben: `{"level":"info","message":"Conversion event received (Sprint 1 — placeholder)","hostname":"localhost","event_name":"test","duration_ms":...}`

**C. CORS preflight**
```bash
curl -X OPTIONS http://localhost:8787/api/event/conversion \
  -H "Origin: https://painlessremovals.com" -i
```
→ `204` + CORS headers

**D. 404 ismeretlen path-ra**
```bash
curl http://localhost:8787/random/path
```
→ `404 Not found`

### Production deploy

```bash
npm run deploy
```

**E. Production health**
```bash
curl https://painlessremovals.com/api/event/health
```
→ `200 OK`

**F. Cloudflare logs**
Cloudflare dashboard → Workers → soborbo-tracking → Logs: structured JSON megjelennek
NINCS unhandled exception 5 perces rendes traffic alatt

## Sprint 1 utáni státusz

- ✅ Worker scaffolding kész
- ✅ KV és R2 binding működik (még nem használjuk)
- ✅ TypeScript strict mode, observability ON
- ✅ Painless route él, válaszol
- ❌ Tényleges API integrációk: Sprint 4-7
- ❌ Hash + normalize: Sprint 3
- ❌ Site config olvasás: Sprint 2
- ❌ Turnstile validation: Sprint 2
- ❌ Multi-tenant rollout: Sprint 10

## Mit KÉRDEZZ a usertől, mielőtt kezded

1. SITE_CONFIG KV namespace ID
2. OAUTH_TOKENS KV namespace ID
3. R2 bucket neve (alapértelmezett: `soborbo-tracking-dlq`)
4. Cloudflare account ID
5. Painless route megerősítése: `painlessremovals.com/api/event/*` — vagy `*.painlessremovals.com/api/event/*` (WWW és root mindkettő)?
