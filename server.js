const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// --- Настройки задержек между проверками (чтобы снизить риск бана) ---
const DELAY_MIN_MS = parseInt(process.env.DELAY_MIN_MS || '4000', 10);
const DELAY_MAX_MS = parseInt(process.env.DELAY_MAX_MS || '9000', 10);
// Каждые BATCH_SIZE проверок — длинная пауза
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '40', 10);
const BATCH_PAUSE_MS = parseInt(process.env.BATCH_PAUSE_MS || '60000', 10);

function randomDelay(min, max) {
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
}

// --- Состояние клиента ---
let clientState = { status: 'starting', qr: null }; // starting | qr | authenticated | ready | auth_failure
let job = null; // { total, checked, results: [], done, running, cancelled }

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', async (qr) => {
  clientState.status = 'qr';
  clientState.qr = await qrcode.toDataURL(qr);
  console.log('QR обновлён, отсканируй его в веб-интерфейсе');
});

client.on('authenticated', () => {
  clientState.status = 'authenticated';
  clientState.qr = null;
});

client.on('ready', () => {
  clientState.status = 'ready';
  clientState.qr = null;
  console.log('WhatsApp клиент готов');
});

client.on('auth_failure', (msg) => {
  clientState.status = 'auth_failure';
  console.error('Ошибка авторизации:', msg);
});

client.on('disconnected', (reason) => {
  clientState.status = 'starting';
  console.error('Клиент отключён:', reason);
});

client.initialize();

// --- Утилита: привести номер к формату для whatsapp-web.js (страна+номер, без +, пробелов, тире) ---
function normalizeNumber(raw) {
  return raw.replace(/[^\d]/g, '');
}

async function runJob(numbers) {
  job.running = true;
  for (let i = 0; i < numbers.length; i++) {
    if (job.cancelled) break;
    const raw = numbers[i];
    const normalized = normalizeNumber(raw);
    let result = { number: raw, normalized, hasWhatsapp: null, error: null };
    if (!normalized) {
      result.error = 'Пустой/некорректный номер';
    } else {
      try {
        const numberId = await client.getNumberId(normalized);
        result.hasWhatsapp = !!numberId;
      } catch (e) {
        result.error = String(e.message || e);
      }
    }
    job.results.push(result);
    job.checked = i + 1;

    if (i < numbers.length - 1 && !job.cancelled) {
      await randomDelay(DELAY_MIN_MS, DELAY_MAX_MS);
      if ((i + 1) % BATCH_SIZE === 0) {
        console.log(`Пауза ${BATCH_PAUSE_MS}мс после ${i + 1} проверок...`);
        await randomDelay(BATCH_PAUSE_MS, BATCH_PAUSE_MS + 5000);
      }
    }
  }
  job.done = true;
  job.running = false;
}

// --- API ---

app.get('/api/status', (req, res) => {
  res.json({ clientStatus: clientState.status, qr: clientState.qr });
});

app.post('/api/check', (req, res) => {
  if (clientState.status !== 'ready') {
    return res.status(400).json({ error: 'WhatsApp клиент ещё не готов. Сначала отсканируй QR.' });
  }
  if (job && job.running) {
    return res.status(400).json({ error: 'Проверка уже идёт. Дождись завершения или отмени.' });
  }
  const { numbers } = req.body;
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'Список номеров пуст.' });
  }
  const cleaned = numbers.map((n) => String(n).trim()).filter(Boolean);
  job = { total: cleaned.length, checked: 0, results: [], done: false, running: false, cancelled: false };
  runJob(cleaned);
  res.json({ started: true, total: cleaned.length });
});

app.post('/api/cancel', (req, res) => {
  if (job) job.cancelled = true;
  res.json({ cancelled: true });
});

app.get('/api/progress', (req, res) => {
  if (!job) return res.json({ noJob: true });
  res.json({
    total: job.total,
    checked: job.checked,
    done: job.done,
    running: job.running,
    results: job.results
  });
});

app.get('/api/download', (req, res) => {
  if (!job || job.results.length === 0) {
    return res.status(400).send('Нет результатов для скачивания.');
  }
  const rows = ['number,has_whatsapp,error'];
  for (const r of job.results) {
    rows.push(`${r.number},${r.hasWhatsapp === null ? '' : r.hasWhatsapp},${r.error || ''}`);
  }
  const csv = rows.join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="whatsapp_results.csv"');
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
