/**
 * Scribdly Worker — Core Extractor
 *
 * Stateless extraction logic. Accepts a Scribd documentId,
 * fetches and assembles all pages into a PDF, and returns
 * the raw PDF bytes (Buffer) along with metadata.
 *
 * No MongoDB. No filesystem writes. No SSE. Pure compute.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-core');
const { PDFDocument } = require('pdf-lib');

// ─── Browser Headers ─────────────────────────────────
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Referer: 'https://www.google.com/',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
};

// ─── Chrome Detection ─────────────────────────────────
function getBrowserExecutablePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ─── Document Failure Detection ───────────────────────
function isDocumentConversionFailed(html) {
  if (!html || typeof html !== 'string') return false;
  return (
    html.includes('Document failed to convert') ||
    html.includes("Sorry, we can't display this document") ||
    html.includes('auto__embeds_unavailable') ||
    html.includes('embeds_error')
  );
}

// ─── Normalize Image URLs ─────────────────────────────
function normalizeImageUrl(rawUrl) {
  if (!rawUrl) return null;
  let url = rawUrl.trim();
  if (url.startsWith('http://html.scribd.com/')) {
    url = url.replace('http://html.scribd.com/', 'https://html.scribd.com/');
  } else if (url.startsWith('http://html.scribdassets.com/')) {
    url = url.replace('http://html.scribdassets.com/', 'https://html.scribd.com/');
  } else if (url.startsWith('https://html.scribdassets.com/')) {
    url = url.replace('https://html.scribdassets.com/', 'https://html.scribd.com/');
  }
  if (url.includes('?')) url = url.split('?')[0];
  return url;
}

// ─── Fetch Scribd Embed HTML ──────────────────────────
async function fetchEmbedHtml(documentId) {
  const embedUrl = `https://www.scribd.com/embeds/${documentId}/content`;

  // First attempt: direct
  try {
    const res = await axios.get(embedUrl, {
      headers: BROWSER_HEADERS,
      timeout: 15000,
      validateStatus: false,
    });
    if (res.status === 200 && res.data?.length > 5000 && !res.data.includes('Client Challenge')) {
      return res.data;
    }
  } catch (err) {
    console.warn(`[Extractor] Direct embed fetch error: ${err.message}`);
  }

  // Warmup sequence
  const warmupUrls = [
    `https://www.scribd.com/doc-page/v2/${documentId}`,
    `https://www.scribd.com/api/v2/documents/${documentId}`,
    `https://www.scribd.com/document/${documentId}`,
    embedUrl,
  ];

  for (const url of warmupUrls) {
    try {
      const res = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 15000, validateStatus: false });
      if (url === embedUrl && res.status === 200 && res.data?.length > 5000 && !res.data.includes('Client Challenge')) {
        return res.data;
      }
    } catch {}
  }

  // Final attempt
  const finalRes = await axios.get(embedUrl, { headers: BROWSER_HEADERS, timeout: 20000, validateStatus: false });
  return finalRes.data || '';
}

// ─── Detect Hybrid vs Image Document ─────────────────
function isHybridDocument(html) {
  if (!html) return false;
  const $ = cheerio.load(html);
  let totalTextLength = 0;
  let hasMultipleImages = false;

  $('.newpage').each((i, el) => {
    const text = $(el).find('.text_layer').text().replace(/scanned\s+by\s+camscanner/gi, '').trim();
    totalTextLength += text.length;
    if ($(el).find('img').length > 1) hasMultipleImages = true;
  });

  const fontMatches = html.match(/docManager\.addFont\(/g);
  const fontCount = fontMatches ? fontMatches.length : 0;

  const isHybrid = (fontCount > 2 && totalTextLength > 80) || totalTextLength > 200 || hasMultipleImages;
  return isHybrid;
}

// ─── Parse Image Pages ────────────────────────────────
async function parseDocumentPages(html) {
  const $ = cheerio.load(html);
  const pages = new Map();

  // Extract inline pages from HTML
  $('.newpage').each((i, el) => {
    const pageId = $(el).attr('id') || '';
    const pageNum = parseInt(pageId.replace(/\D/g, ''), 10) || i + 1;
    const imgEl = $(el).find('img.absimg, img');
    const normalized = normalizeImageUrl(imgEl.attr('orig') || imgEl.attr('src'));
    const style = $(el).attr('style') || '';
    const wMatch = style.match(/width:\s*(\d+)px/i);
    const hMatch = style.match(/height:\s*(\d+)px/i);
    const width = wMatch ? parseInt(wMatch[1], 10) : 900;
    const height = hMatch ? parseInt(hMatch[1], 10) : 1200;
    if (normalized) {
      pages.set(pageNum, { pageNum, imageUrl: normalized, width, height });
    }
  });

  // Extract asset prefix
  let assetPrefix = null;
  const prefixMatch =
    html.match(/docManager\.assetPrefix\s*=\s*["']([^"']+)["']/i) ||
    html.match(/https?:\/\/(?:html\.scribd(?:assets)?\.com)\/([a-z0-9]{16})/i) ||
    html.match(/["']format_uuid["']\s*:\s*["']([^"']+)["']/i);
  if (prefixMatch) assetPrefix = prefixMatch[1];

  // Resolve docManager.addPage() entries
  const jsonpEntries = [];
  const addPageBlocks = html.match(/docManager\.addPage\(\s*\{[\s\S]*?\}\s*\);/g) || [];

  for (const block of addPageBlocks) {
    const pageNumMatch = block.match(/pageNum:\s*(\d+)/);
    const contentUrlMatch = block.match(/contentUrl:\s*["']([^"']+\.jsonp)["']/);
    const origWidthMatch = block.match(/origWidth:\s*(\d+)/);
    const origHeightMatch = block.match(/origHeight:\s*(\d+)/);
    const width = origWidthMatch ? parseInt(origWidthMatch[1], 10) : 900;
    const height = origHeightMatch ? parseInt(origHeightMatch[1], 10) : 1200;

    if (pageNumMatch) {
      const pageNum = parseInt(pageNumMatch[1], 10);
      if (contentUrlMatch) {
        let contentUrl = contentUrlMatch[1];
        if (contentUrl.startsWith('http://')) {
          contentUrl = contentUrl.replace('http://', 'https://');
        }
        if (contentUrl.includes('html.scribdassets.com')) {
          contentUrl = contentUrl.replace('html.scribdassets.com', 'html.scribd.com');
        }
        const hashMatch = contentUrl.match(/pages\/(.+)\.jsonp/);
        if (hashMatch && assetPrefix) {
          pages.set(pageNum, {
            pageNum,
            imageUrl: `https://html.scribd.com/${assetPrefix}/images/${hashMatch[1]}.jpg`,
            contentUrl,
            width,
            height,
          });
        } else {
          jsonpEntries.push({ pageNum, contentUrl, width, height });
        }
      } else if (pages.has(pageNum)) {
        const existing = pages.get(pageNum);
        existing.width = width;
        existing.height = height;
      }
    }
  }

  // Batch fetch any unresolved JSONP pages
  if (jsonpEntries.length > 0) {
    const BATCH = 30;
    for (let i = 0; i < jsonpEntries.length; i += BATCH) {
      const batch = jsonpEntries.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async ({ pageNum, contentUrl, width, height }) => {
          try {
            const res = await axios.get(contentUrl, { timeout: 8000, validateStatus: (s) => s === 200 });
            const text = (res.data || '').replace(/\\"/g, '"');
            const imgMatch =
              text.match(/<img[^>]+orig=["']([^"']+)["']/i) ||
              text.match(/<img[^>]+src=["']([^"']+)["']/i);
            let imgUrl = imgMatch ? normalizeImageUrl(imgMatch[1]) : null;
            if (!imgUrl && assetPrefix) {
              const hashMatch = contentUrl.match(/pages\/(.+)\.jsonp/);
              if (hashMatch) imgUrl = `https://html.scribd.com/${assetPrefix}/images/${hashMatch[1]}.jpg`;
            }
            const wMatch = text.match(/width:\s*(\d+)px/i);
            const hMatch = text.match(/height:\s*(\d+)px/i);
            const finalW = wMatch ? parseInt(wMatch[1], 10) : width;
            const finalH = hMatch ? parseInt(hMatch[1], 10) : height;
            pages.set(pageNum, { pageNum, imageUrl: imgUrl, contentUrl, width: finalW, height: finalH });
          } catch {}
        })
      );
    }
  }

  const sorted = Array.from(pages.values()).sort((a, b) => a.pageNum - b.pageNum);
  return { pages: sorted, totalPages: sorted.length };
}

// ─── Image Document → PDF Buffer ─────────────────────
async function extractImageDocumentToBuffer(documentId, html, startPage = null, endPage = null) {
  const { pages, totalPages } = await parseDocumentPages(html);

  if (totalPages === 0) {
    throw new Error('No printable image pages found in this document.');
  }

  const from = Math.max(1, parseInt(startPage, 10) || 1);
  const to = Math.min(totalPages, parseInt(endPage, 10) || totalPages);

  // Filter pages to the requested range
  const targetPages = pages.filter((p) => p.pageNum >= from && p.pageNum <= to);

  const pdfDoc = await PDFDocument.create();
  const CONCURRENCY = 12;
  let thumbnailUrl = from === 1 ? (pages[0]?.imageUrl || '') : '';
  let embeddedCount = 0;
  let firstError = null;

  for (let i = 0; i < targetPages.length; i += CONCURRENCY) {
    const chunk = targetPages.slice(i, i + CONCURRENCY);

    const downloaded = await Promise.all(
      chunk.map(async (page) => {
        // Construct URLs to try: prioritize html.scribd.com first, then fallback to html.scribdassets.com
        const urlsToTry = [];
        if (page.imageUrl) {
          const primaryUrl = page.imageUrl.replace('html.scribdassets.com', 'html.scribd.com');
          urlsToTry.push(primaryUrl);
          const fallbackUrl = primaryUrl.replace('html.scribd.com', 'html.scribdassets.com');
          if (fallbackUrl !== primaryUrl) {
            urlsToTry.push(fallbackUrl);
          }
        }

        for (const url of urlsToTry) {
          try {
            const res = await axios.get(url, {
              responseType: 'arraybuffer',
              timeout: 15000,
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                Referer: 'https://www.scribd.com/',
                Accept: 'image/jpeg,image/png,*/*',
                'Accept-Language': 'en-US,en;q=0.9',
              },
              validateStatus: (status) => status === 200,
            });
            if (res.data && res.data.length > 0) {
              return { page, buffer: Buffer.from(res.data), isBlank: false };
            }
          } catch {
            // First origin failed, try next without warning
          }
        }

        // Image downloads failed from all origins.
        // Check if page has contentUrl (.jsonp) to inspect for blank page or inline image.
        if (page.contentUrl) {
          const jsonpUrls = [
            page.contentUrl.replace('html.scribdassets.com', 'html.scribd.com'),
            page.contentUrl.replace('html.scribd.com', 'html.scribdassets.com'),
          ];

          for (const jUrl of jsonpUrls) {
            try {
              const jRes = await axios.get(jUrl, {
                timeout: 10000,
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                  Referer: 'https://www.scribd.com/',
                },
                validateStatus: (status) => status === 200,
              });

              if (jRes.data && typeof jRes.data === 'string') {
                const text = jRes.data.replace(/\\"/g, '"');
                const imgMatch =
                  text.match(/<img[^>]+orig=["']([^"']+)["']/i) ||
                  text.match(/<img[^>]+src=["']([^"']+)["']/i);

                if (imgMatch) {
                  const altUrl = normalizeImageUrl(imgMatch[1]);
                  if (altUrl && !urlsToTry.includes(altUrl)) {
                    try {
                      const altRes = await axios.get(altUrl, {
                        responseType: 'arraybuffer',
                        timeout: 15000,
                        headers: { Referer: 'https://www.scribd.com/' },
                        validateStatus: (status) => status === 200,
                      });
                      if (altRes.data && altRes.data.length > 0) {
                        return { page, buffer: Buffer.from(altRes.data), isBlank: false };
                      }
                    } catch {}
                  }
                }

                // Legitimate blank/text-only page
                const wMatch = text.match(/width:\s*(\d+)px/i);
                const hMatch = text.match(/height:\s*(\d+)px/i);
                const width = wMatch ? parseInt(wMatch[1], 10) : (page.width || 900);
                const height = hMatch ? parseInt(hMatch[1], 10) : (page.height || 1200);

                console.log(`[Extractor] 📄 Preserved blank page ${page.pageNum} (${width}x${height})`);
                return { page, buffer: null, isBlank: true, width, height };
              }
            } catch {}
          }
        }

        // If dimensions were provided in addPage, preserve the page as blank rather than dropping it
        if (page.width && page.height) {
          console.warn(`[Extractor] ⚠️ Image failed for page ${page.pageNum}; inserting blank page (${page.width}x${page.height})`);
          return { page, buffer: null, isBlank: true, width: page.width, height: page.height };
        }

        if (!firstError) {
          firstError = `Failed to fetch page ${page.pageNum} from all origins`;
        }
        console.error(`[Extractor] ❌ Failed to fetch page ${page.pageNum} (${page.imageUrl}) from all origins`);
        return { page, buffer: null, isBlank: false };
      })
    );

    for (const item of downloaded) {
      const { page, buffer, isBlank, width: blankW, height: blankH } = item;

      if (isBlank) {
        const pageW = blankW || 900;
        const pageH = blankH || 1200;
        pdfDoc.addPage([pageW, pageH]);
        embeddedCount++;
        continue;
      }

      if (!buffer) continue;

      try {
        const isPng = page.imageUrl?.endsWith('.png') || (buffer[0] === 0x89 && buffer[1] === 0x50);
        const embeddedImg = isPng ? await pdfDoc.embedPng(buffer) : await pdfDoc.embedJpg(buffer);
        const { width, height } = embeddedImg;
        const pdfPage = pdfDoc.addPage([width, height]);
        pdfPage.drawImage(embeddedImg, { x: 0, y: 0, width, height });
        embeddedCount++;
      } catch (embErr) {
        if (!firstError) firstError = `Embed error on page ${page.pageNum}: ${embErr.message}`;
        console.warn(`[Extractor] Could not embed page ${page.pageNum}: ${embErr.message}`);
      }
    }
  }

  if (embeddedCount === 0) {
    throw new Error(
      `Failed to embed any image pages into PDF (${targetPages.length} pages attempted in range ${from}..${to}). Error: ${firstError}`
    );
  }

  const pdfBytes = await pdfDoc.save();
  return {
    pdfBuffer: Buffer.from(pdfBytes),
    totalPages,
    startPage: from,
    endPage: to,
    partPages: embeddedCount,
    thumbnailUrl,
  };
}

// ─── Hybrid Document → PDF Buffer (Puppeteer) ────────
async function extractHybridDocumentToBuffer(documentId, browserPath, startPage = null, endPage = null, html = null) {
  // Create isolated, unique temporary profile directory per extraction session (prevents SingletonLock collision)
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), `chrome-session-${documentId}-${Date.now()}-`));

  let browser;
  try {
    const scaleFactor = 1.5;
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: 'new',
      protocolTimeout: 240000,
      userDataDir: sessionDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--mute-audio',
        '--disk-cache-size=104857600',
        '--disable-crash-reporter',
        '--disable-breakpad',
        '--crash-dumps-dir=/tmp',
        `--user-data-dir=${sessionDir}`,
        '--disable-gpu',
        '--hide-scrollbars',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1800, deviceScaleFactor: scaleFactor });

    // Stealth evasion: mask navigator.webdriver and mock chrome environment
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
      window.chrome = {
        runtime: {},
        loadTimes: function () {},
        csi: function () {},
        app: {},
      };
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
    });

    // Set genuine browser user-agent so Scribd does not block headless Chrome
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });

    // Block non-essential tracking/analytics for speed, but NEVER block Scribd or Cloudflare challenge assets
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const rawUrl = req.url();
      const url = rawUrl.toLowerCase();

      // Automatically rewrite scribdassets.com to html.scribd.com to bypass Fastly image optimizer 403 blocks
      if (rawUrl.includes('html.scribdassets.com')) {
        return req.continue({
          url: rawUrl.replace('html.scribdassets.com', 'html.scribd.com'),
        });
      }

      // NEVER block Scribd, Cloudflare challenge, or CDN assets
      if (
        url.includes('scribd.com') ||
        url.includes('scribdassets.com') ||
        url.includes('cdn-cgi') ||
        url.includes('challenges.cloudflare.com') ||
        url.includes('cloudflare.com')
      ) {
        return req.continue();
      }

      if (
        url.includes('google-analytics') ||
        url.includes('googletagmanager') ||
        url.includes('stripe') ||
        url.includes('branch.io') ||
        url.includes('facebook') ||
        url.includes('doubleclick') ||
        url.includes('amplitude') ||
        url.includes('segment') ||
        url.includes('hotjar')
      ) {
        return req.abort();
      }
      return req.continue();
    });

    // Check if we have valid pre-resolved embed HTML (not bot challenge and not embed error page)
    const hasValidHtml =
      html &&
      typeof html === 'string' &&
      html.length > 1000 &&
      !html.includes('Client Challenge') &&
      !isDocumentConversionFailed(html);

    if (hasValidHtml) {
      let pageHtml = html;
      // Pre-rewrite asset host to html.scribd.com so all dynamic scripts load with HTTP 200
      pageHtml = pageHtml.replace(/https?:\/\/html\.scribdassets\.com/g, 'https://html.scribd.com');
      if (!pageHtml.includes('<base')) {
        pageHtml = pageHtml.replace(/<head[^>]*>/i, '$&<base href="https://www.scribd.com/">');
      }
      await page.setContent(pageHtml, { waitUntil: 'domcontentloaded' });
    } else {
      // Navigate to the main document page!
      // This is crucial because some documents (like 269431184) have broken/disabled embeds,
      // but are completely readable and healthy on the main document URL!
      const docUrl = `https://www.scribd.com/document/${documentId}`;
      console.log(`[Extractor] Navigating to main document URL: ${docUrl}`);
      await page.goto(docUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    }

    try {
      await page.waitForFunction(
        () => !!window.docManager || !!document.querySelector('.outer_page, .newpage'),
        { timeout: 30000 }
      );
    } catch (waitErr) {
      // If we used pre-resolved HTML or embed and it failed, try navigating to the main document page!
      const currentUrl = page.url();
      if (!currentUrl.includes(`/document/${documentId}`)) {
        console.warn(`[Extractor] Embed view failed for ${documentId}. Retrying via main document page...`);
        const docUrl = `https://www.scribd.com/document/${documentId}`;
        await page.goto(docUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await page.waitForFunction(
          () => !!window.docManager || !!document.querySelector('.outer_page, .newpage'),
          { timeout: 30000 }
        );
      } else {
        const pageTitle = await page.title().catch(() => '');
        const bodySnippet = await page
          .evaluate(() => (document.body ? document.body.innerText.slice(0, 300) : ''))
          .catch(() => '');
        console.error(
          `[Extractor] Reader wait failed on ${currentUrl}. Title: "${pageTitle}", Preview: "${bodySnippet.replace(/\s+/g, ' ')}"`
        );
        throw new Error(`Scribd reader did not initialize (Title: "${pageTitle}"). ${waitErr.message}`);
      }
    }

    // Click Fullscreen button to switch to clean, borderless reader layout without website headers/sidebars
    try {
      await page.evaluate(() => {
        const fsBtn =
          document.querySelector('button[aria-label="Fullscreen" i]') ||
          document.querySelector('[aria-label*="fullscreen" i]') ||
          document.querySelector('button.fullscreen_btn, .fullscreen_btn') ||
          document.querySelector('button[title*="fullscreen" i]');
        if (fsBtn) {
          fsBtn.click();
        }
      });
      await new Promise((r) => setTimeout(r, 600));
    } catch (fsErr) {
      console.warn(`[Extractor] Fullscreen trigger note: ${fsErr.message}`);
    }

    // If document is pure image pages without complex vectors/fonts, use fast parallel image download
    const renderedHtml = await page.content();
    const isDocHybrid = isHybridDocument(renderedHtml);
    if (!isDocHybrid) {
      await browser.close().catch(() => {});
      try {
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {}
      return await extractImageDocumentToBuffer(documentId, renderedHtml, startPage, endPage);
    }

    // Inject style to un-blur blurred pages, force hidden webfont containers visible, and flush fonts
    await page.evaluate(() => {
      // 1. Remove interfering fixed and sticky chrome (headers, cookies, toolbars)
      document.querySelectorAll('*').forEach((el) => {
        try {
          const s = window.getComputedStyle(el);
          if (s.position === 'fixed' || s.position === 'sticky') {
            if (!el.closest('.outer_page, .newpage, #document_container, .outer_page_container, [id^="page"], [id^="outer_page_"]')) {
              el.remove();
            }
          }
        } catch {}
      });

      // 2. Remove sidebars, headers, banners, cookies, ads
      document.querySelectorAll(
        'aside, [class*="sidebar"], #global_header, [class*="_2MHqNa"], [class*="osano"], ins.adsbygoogle, iframe[id*="google"], [id*="aswift"], [id*="google_vignette"], [class*="toolbar"], [class*="between_page"], [class*="promo"]'
      ).forEach((e) => e.remove());

      const style = document.createElement('style');
      style.innerHTML = `
        #global_header, ._2MHqNa, .osano-cm-window, .osano-cm-dialog, [class*="osano"],
        aside, [class*="sidebar"], [class*="toolbar"], [class*="between_page"], [class*="promo"],
        ins.adsbygoogle, iframe[id*="google"], [id*="aswift"], [id*="google_vignette"] {
          display: none !important;
          visibility: hidden !important;
        }
        .outer_page {
          overflow: hidden !important;
        }
        .ff0, .ff1, .ff2, .ff3, .ff4, .ff5, .ff6, .ff7, .ff8, .ff9, span[class*="ff"], div[class*="ff"], .text_layer, .text_layer * {
          display: inline-block !important;
          visibility: visible !important;
          opacity: 1 !important;
          color: #000 !important;
          text-shadow: none !important;
          filter: none !important;
          -webkit-text-fill-color: initial !important;
        }
        .outer_page.blurred_page, .blurred_page, [class*="blurred"] {
          filter: none !important;
          -webkit-filter: none !important;
          opacity: 1 !important;
        }
        .outer_page.blurred_page .text_layer,
        .blurred_page .text_layer {
          filter: none !important;
          -webkit-filter: none !important;
          text-shadow: none !important;
          color: #000 !important;
        }
        .outer_page.blurred_page .image_layer img,
        .blurred_page .image_layer img {
          filter: none !important;
          -webkit-filter: none !important;
          opacity: 1 !important;
        }
      `;
      document.head.appendChild(style);
    });

    const docInfo = await page.evaluate(() => {
      if (window.docManager) {
        return {
          totalPages: Object.keys(window.docManager.pages || {}).length,
        };
      }
      return { totalPages: document.querySelectorAll('.newpage').length };
    });

    const totalPages = docInfo.totalPages || 1;
    const from = Math.max(1, parseInt(startPage, 10) || 1);
    const to = Math.min(totalPages, parseInt(endPage, 10) || totalPages);

    const pdfDoc = await PDFDocument.create();
    let thumbnailUrl = '';
    let embeddedCount = 0;

    for (let p = from; p <= to; p++) {
      try {
        await page.evaluate((pNum) => {
          if (window.docManager) {
            try { window.docManager.gotoPage(pNum); } catch {}
            try {
              if (window.docManager.pages && window.docManager.pages[pNum]) {
                window.docManager.pages[pNum].load();
                window.docManager.pages[pNum].display();
              }
            } catch {}
          }
          const outerEl = document.getElementById('outer_page_' + pNum);
          if (outerEl) {
            outerEl.scrollIntoView({ behavior: 'instant', block: 'center' });
          }
          const el = document.getElementById('page' + pNum);
          if (el) {
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
            // Pre-assign image src from orig attribute to prevent layout mutations during screenshot
            const imgs = el.querySelectorAll('img');
            imgs.forEach((img) => {
              const orig = img.getAttribute('orig');
              if (orig && !img.src) {
                img.src = orig.replace(/html\.scribdassets\.com/g, 'html.scribd.com');
              }
            });
          }
          // Memory guard: detach images on older rendered pages (pNum - 2 and below)
          // while preserving element heights to prevent scroll jumps
          for (let oldP = 1; oldP < pNum - 1; oldP++) {
            const oldEl = document.getElementById('page' + oldP);
            if (oldEl && !oldEl.dataset.purged) {
              const imgs = oldEl.querySelectorAll('img');
              imgs.forEach((img) => {
                if (!img.style.minHeight && img.offsetHeight) {
                  img.style.minHeight = img.offsetHeight + 'px';
                }
                img.src = '';
                if (img.srcset) img.srcset = '';
              });
              oldEl.dataset.purged = 'true';
            }
          }
        }, p);

        try {
          await page.waitForFunction(
            (pNum) => {
              const outer = document.getElementById('outer_page_' + pNum);
              const el = document.getElementById('page' + pNum);
              const target = el || outer;
              if (!target) return false;
              const imgs = Array.from(target.querySelectorAll('img'));
              for (const img of imgs) {
                if (img.getAttribute('orig') && !img.src) return false;
                if (img.src && (!img.complete || img.naturalWidth === 0)) return false;
              }
              return target.offsetHeight > 50;
            },
            { timeout: 9000 },
            p
          );
          // Wait for webfonts to finish rendering so no text is skipped or blurred
          await page.evaluate(() => document.fonts.ready).catch(() => {});
          await new Promise((r) => setTimeout(r, 150));
        } catch (waitErr) {
          const elExists = await page.evaluate(
            (pNum) => !!(document.getElementById('page' + pNum) || document.getElementById('outer_page_' + pNum)),
            p
          );
          if (!elExists) {
            throw waitErr;
          }
        }

        const targetEl = (await page.$(`#outer_page_${p}`)) || (await page.$(`#page${p}`));
        if (targetEl) {
          let imgBuf = null;

          // Attempt 1: Direct element screenshot (with target centered in viewport)
          try {
            await page.evaluate((pNum) => {
              const outer = document.getElementById('outer_page_' + pNum);
              const el = document.getElementById('page' + pNum);
              const target = outer || el;
              if (target) target.scrollIntoView({ behavior: 'instant', block: 'center' });
            }, p);
            imgBuf = await targetEl.screenshot({ type: 'jpeg', quality: 90, captureBeyondViewport: false });
          } catch (elErr) {
            console.warn(`[Extractor] Direct element screenshot on page ${p} failed: ${elErr.message}, trying viewport fallback...`);
          }

          // Attempt 2: Viewport-clipped screenshot fallback with strict bounds clamping
          if (!imgBuf) {
            try {
              const rect = await page.evaluate((pNum) => {
                const outer = document.getElementById('outer_page_' + pNum);
                const el = document.getElementById('page' + pNum);
                const target = outer || el;
                if (!target) return null;
                target.scrollIntoView({ behavior: 'instant', block: 'center' });
                const r = target.getBoundingClientRect();
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const left = Math.max(0, Math.min(vw - 1, r.left));
                const top = Math.max(0, Math.min(vh - 1, r.top));
                const width = Math.max(1, Math.min(vw - left, r.width > 0 ? r.width : target.offsetWidth));
                const height = Math.max(1, Math.min(vh - top, r.height > 0 ? r.height : target.offsetHeight));
                return { x: left, y: top, width, height };
              }, p);

              if (rect && rect.width > 0 && rect.height > 0) {
                imgBuf = await page.screenshot({
                  type: 'jpeg',
                  quality: 85,
                  captureBeyondViewport: false,
                  clip: {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                  },
                });
              }
            } catch (vpErr) {
              console.warn(`[Extractor] Viewport fallback on page ${p} failed: ${vpErr.message}`);
            }
          }

          // Attempt 3: Direct asset fetch fallback (ensures ZERO dropped pages even if Chromium fails)
          if (!imgBuf) {
            try {
              const fallbackUrl = await page.evaluate((pNum) => {
                const el = document.getElementById('page' + pNum);
                if (!el) return null;
                const img = el.querySelector('img.absimg, img');
                return img ? img.getAttribute('orig') || img.src : null;
              }, p);
              if (fallbackUrl) {
                const directUrl = fallbackUrl.replace(/html\.scribdassets\.com/g, 'html.scribd.com');
                const res = await axios.get(directUrl, {
                  responseType: 'arraybuffer',
                  timeout: 10000,
                  headers: { Referer: 'https://www.scribd.com/' },
                });
                imgBuf = Buffer.from(res.data);
                console.log(`[Extractor] Recovered page ${p} via direct image download fallback`);
              }
            } catch (fetchErr) {
              console.warn(`[Extractor] Direct image download fallback for page ${p} failed: ${fetchErr.message}`);
            }
          }

          if (imgBuf) {
            const embeddedImg = await pdfDoc.embedJpg(imgBuf);
            const { width, height } = embeddedImg;
            const pdfPage = pdfDoc.addPage([width / scaleFactor, height / scaleFactor]);
            pdfPage.drawImage(embeddedImg, {
              x: 0,
              y: 0,
              width: width / scaleFactor,
              height: height / scaleFactor,
            });
            embeddedCount++;

            if (p === 1) {
              thumbnailUrl = await page.evaluate(() => {
                const el = document.getElementById('page1');
                const img = el?.querySelector('img');
                return img ? img.getAttribute('orig') || img.src : '';
              });
            }
          }
        }
      } catch (pageErr) {
        console.warn(`[Extractor] Page ${p} error: ${pageErr.message}`);
      }

      if (p % 5 === 0 || p === to) {
        console.log(`[Extractor] Progress: ${p}/${to} (range: ${from}..${to})`);
      }
    }

    if (embeddedCount === 0) {
      throw new Error(`Failed to capture any hybrid pages for document ${documentId} in range ${from}..${to}`);
    }

    const pdfBytes = await pdfDoc.save();
    return {
      pdfBuffer: Buffer.from(pdfBytes),
      totalPages,
      startPage: from,
      endPage: to,
      partPages: embeddedCount,
      thumbnailUrl,
    };
  } finally {
    if (browser) {
      try {
        const proc = browser.process();
        await browser.close().catch(() => {});
        if (proc && !proc.killed) {
          try {
            proc.kill('SIGKILL');
          } catch {}
        }
      } catch {}
    }
    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

// ─── Main Entry Point ─────────────────────────────────
/**
 * Extract a Scribd document to PDF and return raw bytes.
 * @param {string} documentId - Numeric Scribd document ID
 * @param {string|null} [initialHtml] - Optional pre-fetched embed HTML from the base VPS
 * @param {number|null} [startPage] - Starting page number (inclusive)
 * @param {number|null} [endPage] - Ending page number (inclusive)
 * @returns {{ pdfBuffer: Buffer, totalPages: number, startPage: number, endPage: number, partPages: number, thumbnailUrl: string }}
 */
async function extractToPdfBuffer(documentId, initialHtml = null, startPage = null, endPage = null) {
  let html = initialHtml;

  // If HTML is an embed failure page, discard it so we navigate to the main document page
  if (html && isDocumentConversionFailed(html)) {
    html = null;
  }

  if (!html || typeof html !== 'string' || html.length < 1000) {
    const fetched = await fetchEmbedHtml(documentId).catch(() => null);
    if (fetched && !isDocumentConversionFailed(fetched) && !fetched.includes('Client Challenge')) {
      html = fetched;
    } else {
      html = null;
    }
  }

  const browserPath = getBrowserExecutablePath();

  // If no clean HTML or hybrid, use browser which navigates directly to document page
  if (browserPath && (!html || isHybridDocument(html))) {
    return await extractHybridDocumentToBuffer(documentId, browserPath, startPage, endPage, html);
  }

  if (!html) {
    throw new Error('Could not retrieve document content from Scribd. Please try again.');
  }

  // Fast path: direct image extraction
  try {
    return await extractImageDocumentToBuffer(documentId, html, startPage, endPage);
  } catch (imgErr) {
    if (browserPath) {
      console.warn(`[Extractor] Image extraction failed (${imgErr.message}). Falling back to browser...`);
      return await extractHybridDocumentToBuffer(documentId, browserPath, startPage, endPage, html);
    }
    throw imgErr;
  }
}

// ─── Document Inspection (Fast Page Count Discovery) ─
/**
 * Quickly inspects total page count and thumbnail for a document in 1-2 seconds.
 * Avoids rendering or capturing full pages.
 */
async function inspectDocumentInfo(documentId, initialHtml = null) {
  let html = initialHtml;

  if (html && isDocumentConversionFailed(html)) {
    html = null;
  }

  // 1. Fast regex lookup if HTML was provided
  if (html && typeof html === 'string') {
    const docPageMatch =
      html.match(new RegExp(`${documentId}[\\s\\S]{1,500}?"page_count"\\s*:\\s*(\\d+)`, 'i')) ||
      html.match(new RegExp(`"page_count"\\s*:\\s*(\\d+)[\\s\\S]{1,500}?${documentId}`, 'i')) ||
      html.match(/"page_count"\s*:\s*(\d+)/i) ||
      html.match(/totalPages["']?\s*:\s*(\d+)/i) ||
      html.match(/docManager\.pageCount\s*=\s*(\d+)/i);
    if (docPageMatch && docPageMatch[1]) {
      const totalPages = parseInt(docPageMatch[1], 10);
      if (totalPages > 0) return { totalPages };
    }
  }

  // 2. Fetch embed HTML if not provided
  if (!html || html.length < 1000) {
    const fetched = await fetchEmbedHtml(documentId).catch(() => null);
    if (fetched && !isDocumentConversionFailed(fetched)) {
      html = fetched;
    }
  }

  if (html && typeof html === 'string' && !html.includes('Client Challenge')) {
    const m =
      html.match(new RegExp(`${documentId}[\\s\\S]{1,500}?"page_count"\\s*:\\s*(\\d+)`, 'i')) ||
      html.match(new RegExp(`"page_count"\\s*:\\s*(\\d+)[\\s\\S]{1,500}?${documentId}`, 'i')) ||
      html.match(/"page_count"\s*:\s*(\d+)/i) ||
      html.match(/totalPages["']?\s*:\s*(\d+)/i) ||
      html.match(/docManager\.pageCount\s*=\s*(\d+)/i);
    if (m && m[1]) {
      const totalPages = parseInt(m[1], 10);
      if (totalPages > 0) return { totalPages };
    }
  }

  // 3. Fast headless browser inspect (only waits for metadata to load, doesn't capture screenshots)
  const browserPath = getBrowserExecutablePath();
  if (!browserPath) {
    return { totalPages: 1 };
  }

  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), `chrome-peek-${documentId}-${Date.now()}-`));
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: 'new',
      protocolTimeout: 30000,
      userDataDir: sessionDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-breakpad',
        '--disable-crash-reporter',
      ],
    });
    const page = await browser.newPage();
    if (html && typeof html === 'string' && html.length > 1000 && !html.includes('Client Challenge') && !isDocumentConversionFailed(html)) {
      let pageHtml = html;
      if (!pageHtml.includes('<base')) {
        pageHtml = pageHtml.replace(/<head[^>]*>/i, '$&<base href="https://www.scribd.com/">');
      }
      await page.setContent(pageHtml, { waitUntil: 'domcontentloaded' });
    } else {
      await page.goto(`https://www.scribd.com/document/${documentId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
    }

    await page.waitForFunction(() => !!window.docManager || !!document.querySelector('.outer_page, .newpage'), {
      timeout: 15000,
    });

    const docInfo = await page.evaluate(() => {
      if (window.docManager && window.docManager.pages && Object.keys(window.docManager.pages).length > 0) {
        return { totalPages: Object.keys(window.docManager.pages).length };
      }
      const outerCount = document.querySelectorAll('.outer_page').length;
      if (outerCount > 0) return { totalPages: outerCount };
      return { totalPages: document.querySelectorAll('.newpage').length };
    });

    return { totalPages: docInfo.totalPages || 1 };
  } catch (err) {
    console.warn(`[Extractor] Inspect error for ${documentId}: ${err.message}`);
    return { totalPages: 1 };
  } finally {
    if (browser) {
      try {
        const proc = browser.process();
        await browser.close().catch(() => {});
        if (proc && !proc.killed) {
          try {
            proc.kill('SIGKILL');
          } catch {}
        }
      } catch {}
    }
    try {
      if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = { extractToPdfBuffer, inspectDocumentInfo, getBrowserExecutablePath };

