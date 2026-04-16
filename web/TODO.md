# Web backlog

Perf / Lighthouse
- Enable Brotli compression in Cloudflare dashboard
  - Path: zone → Speed → Optimization → Content Optimization → Brotli
  - Currently `content-encoding: gzip` even when clients accept `br`
  - Expected: ~20-25% smaller text responses (HTML, CSS, JS)
- Speculation Rules for prefetch-on-hover on skill card links
  - Makes home → `/skills/<slug>` nav feel instant
  - ~5-10 lines in Layout.astro, gated to desktop
- OG image: check size, compress if >100KB (not LCP-critical)

SEO / structured data
- Skill-detail JSON-LD: consider TechArticle / Article for richer SERP snippets
- robots.txt audit + sitemap ping to Google/Bing on deploy
