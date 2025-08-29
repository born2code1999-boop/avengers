import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// ====== ENV & CONFIG ======
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TOKEN || !CHAT_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

const URLS = (process.env.URLS || 'https://ticketon.kz/sports/futbolniy-klub-kairat,https://ticketon.kz/almaty,https://ticketon.kz/sports')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const INTERVAL_MS = Math.max(10, Number(process.env.CHECK_INTERVAL_SEC || 60)) * 1000;
const ONE_SHOT = String(process.env.ONE_SHOT || '').toLowerCase() === 'true';

// AND-правила: "Кайрат&Реал, Kairat&Real, Реал Мадрид, Real Madrid"
const RAW_RULES = (process.env.KEYWORDS || 'Кайрат&Реал, Kairat&Real, Реал Мадрид, Real Madrid')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const RULES = RAW_RULES.map(rule =>
  rule.toLowerCase().split('&').map(tok => tok.trim()).filter(Boolean)
);

const FORCE_NOTIFY = String(process.env.FORCE_NOTIFY || '').toLowerCase() === 'true';
const NOTIFY_TTL_HOURS = Number(process.env.NOTIFY_TTL_HOURS || 48); // через сколько часов забывать уведомления
const DEEP_CHECK = String(process.env.DEEP_CHECK || 'true').toLowerCase() === 'true'; // ходить внутрь /event/ для отпечатка

const STATE_FILE = path.join(process.cwd(), 'state.json');

// ====== HELPERS ======
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { notified: {}, lastHash: {} }; // { key: ts }, { normHref: hash }
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}
function prune(state) {
  const cutoff = Date.now() - NOTIFY_TTL_HOURS * 3600 * 1000;
  for (const [k, ts] of Object.entries(state.notified)) {
    if (ts < cutoff) delete state.notified[k];
  }
  return state;
}

// простая хеш-функция (детерминированная)
function hash(str) {
  let h = 0, i, chr;
  if (!str) return '0';
  for (i = 0; i < str.length; i++) {
    chr = str.charCodeAt(i);
    h = ((h << 5) - h) + chr;
    h |= 0;
  }
  return String(h);
}

function normalizeHref(href) {
  try {
    const u = new URL(href);
    return u.origin + u.pathname; // без query/hash
  } catch {
    return href || '';
  }
}

function matchesKeywords(text) {
  const t = (text || '').toLowerCase();
  // Совпадение: выполнено хотя бы одно правило, и внутри него присутствуют все токены
  return RULES.some(tokens => tokens.every(tok => t.includes(tok)));
}

// Аккуратная навигация с ретраями
async function gotoWithRetry(page, target, opts = {}, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000, ...opts });
      return;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) continue;
    }
  }
  throw lastErr;
}

// Собираем «отпечаток» содержимого на детальной странице события Ticketon
async function fingerprintEventPage(context, href) {
  const page = await context.newPage();
  try {
    await gotoWithRetry(page, href);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
    // Вытаскиваем значимые куски: заголовок, даты/время, кнопки, цены
    const fp = await page.evaluate(() => {
      const pickText = (sel) => Array.from(document.querySelectorAll(sel))
        .map(n => (n.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' | ');

      const title = pickText('h1, .event-title, [class*="event-title"]');
      const dates = pickText('.date, [class*="date"], time, .event-date, [itemprop*="startDate"], [itemprop*="endDate"]');
      const buttons = pickText('button, a[role="button"]');
      const prices = pickText('[class*="price"], .price, .prices, [class*="ticket"], [class*="tariff"]');

      // Общий текст страницы (обрезанный)
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 5000);

      return { title, dates, buttons, prices, body };
    });

    const fpString = [
      fp.title, fp.dates, fp.buttons, fp.prices
    ].filter(Boolean).join(' || ') + ' || ' + fp.body;

    return hash(fpString);
  } catch {
    // Если не получилось — хоть что-то
    return hash(href);
  } finally {
    await page.close();
  }
}

// ====== CORE ======
async function extractCandidates(page) {
  const anchors = await page.$$eval('a', nodes =>
    nodes.map(a => ({ href: a.href, text: (a.innerText || '').trim() }))
  );

  const candidates = [];
  for (const a of anchors) {
    if (!a.href) continue;
    const href = a.href || '';
    const isTicketonEvent = /ticketon\.kz\/.+\/event\//.test(href);
    if (isTicketonEvent && (matchesKeywords(a.text) || matchesKeywords(href))) {
      candidates.push({ href, text: a.text });
    }
  }
  return candidates;
}



async function checkOnce(bot, browser) {
  let state = loadState();
  state = prune(state); // чистим старые уведомления
  saveState(state);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    locale: 'ru-RU'
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(45000);
  page.setDefaultTimeout(20000);

  for (const target of URLS) {
    try {
      console.log(`[watch] ${target}`);
      await gotoWithRetry(page, target);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
      await sleep(1000);

      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      if (/Комната ожидания|ожидания|очередь/i.test(bodyText)) {
        console.warn('Waiting room detected; continuing anyway.');
      }

      const found = await extractCandidates(page);
      console.log(`  candidates: ${found.length}`);

      // Дедуп по нормализованной ссылке
      const seen = new Set();
      const unique = [];
      for (const item of found) {
        const norm = normalizeHref(item.href || page.url());
        if (seen.has(norm)) continue;
        seen.add(norm);
        unique.push({ ...item, normHref: norm });
      }
      console.log(`  unique: ${unique.length}`);

      for (const item of unique) {
        const isEvent = /ticketon\.kz\/.+\/event\//.test(item.href || '');
        const norm = item.normHref;

        let key, changed = false;

        if (isEvent && DEEP_CHECK) {
          const contentHash = await fingerprintEventPage(context, item.href);
          const lastHash = state.lastHash[norm];
          changed = Boolean(lastHash && lastHash !== contentHash);

          key = `${norm}|${contentHash}`;     // ключ = ссылка + отпечаток контента события
          state.lastHash[norm] = contentHash; // запомнили последний отпечаток
        } else {
          key = norm; // листинги/прочее — только один раз на ссылку
        }

        // Антиспам: не шлём, если уже отправляли такой же ключ (и не форсим)
        if (state.notified[key] && !FORCE_NOTIFY) continue;

        const msg = [
          '👟 Обнаружено событие по ключевым словам!',
          `🔗 ${item.href || page.url()}`,
          item.text ? `🧾 ${item.text}` : null,
          changed ? '♻️ На знакомой странице замечены изменения.' : null,
          '',
          `Источник: ${target}`
        ].filter(Boolean).join('\n');

        await bot.sendMessage(CHAT_ID, msg, { disable_web_page_preview: false });
        state.notified[key] = Date.now();
        saveState(state);
        await sleep(900);
      }

    } catch (err) {
      console.error(`[error] ${target}:`, err?.message || err);
    }
  }

  await context.close();
}

async function main() {
  const bot = new TelegramBot(TOKEN, { polling: false });
  const browser = await chromium.launch({ headless: true });

  try {
    await checkOnce(bot, browser);
    if (ONE_SHOT) return;

    console.log(`Watching ${URLS.length} URLs every ${INTERVAL_MS / 1000}s...`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await sleep(INTERVAL_MS);
      await checkOnce(bot, browser);
    }
  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
