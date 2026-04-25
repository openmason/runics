// Generates public/og-image.png from an inline SVG template.
// Run with: npm run og:build
import { Resvg } from '@resvg/resvg-js'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="85%" cy="15%" r="55%">
      <stop offset="0%" stop-color="#6ee7b7" stop-opacity="0.22"/>
      <stop offset="55%" stop-color="#6ee7b7" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="#6ee7b7" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="15%" cy="95%" r="45%">
      <stop offset="0%" stop-color="#6ee7b7" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#6ee7b7" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="630" fill="#0a0a0b"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect width="1200" height="630" fill="url(#glow2)"/>

  <!-- Subtle top/bottom rules -->
  <line x1="80" y1="130" x2="1120" y2="130" stroke="#1e1e22" stroke-width="1"/>
  <line x1="80" y1="560" x2="1120" y2="560" stroke="#1e1e22" stroke-width="1"/>

  <!-- Logo + wordmark -->
  <g transform="translate(80, 70)">
    <g transform="scale(1.8)">
      <path d="M8 10 L16 6 L24 10 V16 L16 26 L8 16 V10 Z" stroke="#6ee7b7" stroke-width="1.5" fill="none"/>
      <circle cx="16" cy="14" r="3" fill="#6ee7b7" fill-opacity="0.85"/>
    </g>
    <text x="72" y="45" font-family="system-ui, -apple-system, Helvetica, Arial, sans-serif" font-size="32" font-weight="700" fill="#ededed" letter-spacing="-0.5">Runics</text>
  </g>

  <!-- Main heading -->
  <text x="80" y="320" font-family="system-ui, -apple-system, Helvetica, Arial, sans-serif" font-size="92" font-weight="800" fill="#ededed" letter-spacing="-3">Every agent skill.</text>
  <text x="80" y="420" font-family="system-ui, -apple-system, Helvetica, Arial, sans-serif" font-size="92" font-weight="800" fill="#6ee7b7" letter-spacing="-3">Trust-scored.</text>

  <!-- Subtitle -->
  <text x="80" y="500" font-family="system-ui, -apple-system, Helvetica, Arial, sans-serif" font-size="26" font-weight="400" fill="#a0a0a6">
    Semantic skill registry for AI agents · 61,000+ indexed
  </text>

  <!-- Footer bar -->
  <text x="80" y="605" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="18" font-weight="500" fill="#6b6b72">runics.net</text>
  <text x="1120" y="605" text-anchor="end" font-family="system-ui, -apple-system, Helvetica, Arial, sans-serif" font-size="18" fill="#6b6b72">by Cognium Labs</text>
</svg>`

const resvg = new Resvg(svg, {
  background: 'transparent',
  fitTo: { mode: 'width', value: 1200 },
  font: { loadSystemFonts: true },
})

const png = resvg.render().asPng()
const out = resolve(__dirname, '..', 'public', 'og-image.png')
writeFileSync(out, png)
console.log(`Wrote ${out} (${png.length.toLocaleString()} bytes)`)
