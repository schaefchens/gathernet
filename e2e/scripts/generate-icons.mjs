// Renders the app icon SVG to the PNG sizes the manifest needs, using the
// Playwright chromium already installed for e2e. Run: node scripts/generate-icons.mjs
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '../../apps/hub/public/icons')

const icon = (size, maskable) => `<!doctype html><body style="margin:0">
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="${maskable ? 0 : 22}" fill="#0B0F1A"/>
  <circle cx="50" cy="50" r="30" fill="none" stroke="#C9A227" stroke-width="7"
    stroke-dasharray="141 48" stroke-linecap="round" transform="rotate(80 50 50)"/>
  <circle cx="50" cy="50" r="7" fill="#EDE6D6"/>
  <circle cx="73" cy="29" r="6" fill="#C9A227"/>
</svg></body>`

const browser = await chromium.launch()
const page = await browser.newPage()
await mkdir(outDir, { recursive: true })

for (const [size, maskable, name] of [
  [192, false, 'icon-192.png'],
  [512, false, 'icon-512.png'],
  [512, true, 'icon-maskable-512.png'],
]) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(icon(size, maskable))
  const buffer = await page.screenshot({
    clip: { x: 0, y: 0, width: size, height: size },
    omitBackground: !maskable,
  })
  await writeFile(join(outDir, name), buffer)
  console.log(name)
}
await browser.close()
