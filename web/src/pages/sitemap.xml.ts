import type { APIRoute } from 'astro'

// SSR endpoint — fetches live skill slugs from the registry API on each request
// (edge-cached for 1h, CDN for 24h).
export const prerender = false

type LeaderboardEntry = { slug?: string; name?: string; trustScore?: number }

const SITE = 'https://runics.net'
const PAGES = 5 // 5 × 100 slugs = 500 skills exposed to crawlers
const PAGE_SIZE = 100
const FETCH_TIMEOUT_MS = 4000

async function fetchPage(offset: number): Promise<LeaderboardEntry[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(
      `https://api.runics.net/v1/leaderboards/human?limit=${PAGE_SIZE}&offset=${offset}`,
      { signal: controller.signal, headers: { 'User-Agent': 'runics-sitemap' } },
    )
    if (!res.ok) return []
    const data = (await res.json()) as { leaderboard?: LeaderboardEntry[] }
    return data.leaderboard || []
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch] as string),
  )
}

export const GET: APIRoute = async () => {
  const today = new Date().toISOString().split('T')[0]

  // Fetch leaderboard pages in parallel, dedupe by slug
  const pages = await Promise.all(Array.from({ length: PAGES }, (_, i) => fetchPage(i * PAGE_SIZE)))
  const seen = new Set<string>()
  const skills: LeaderboardEntry[] = []
  for (const page of pages) {
    for (const entry of page) {
      if (entry.slug && !seen.has(entry.slug)) {
        seen.add(entry.slug)
        skills.push(entry)
      }
    }
  }

  const urls: string[] = [
    `<url><loc>${SITE}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`,
  ]

  for (const skill of skills) {
    const loc = `${SITE}/skills/${escapeXml(skill.slug!)}`
    // Higher trust → higher priority (0.5–0.9)
    const priority = Math.max(0.5, Math.min(0.9, 0.5 + (skill.trustScore || 0) * 0.4))
    urls.push(
      `<url><loc>${loc}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>${priority.toFixed(2)}</priority></url>`,
    )
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
    },
  })
}
