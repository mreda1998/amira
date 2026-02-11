const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const loadDotEnv = () => {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
};

loadDotEnv();

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.ndjson');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const safeJson = (response, code, payload) => {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
};

const readRequestBody = (request, maxBytes = 1024 * 1024) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('payload_too_large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

const sanitizeText = (value, maxLength = 8000) => String(value || '').trim().slice(0, maxLength);
const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const persistLead = async (lead) => {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.appendFile(LEADS_FILE, `${JSON.stringify(lead)}\n`, 'utf8');
};

const sendEmailWithResend = async (lead) => {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.LEADS_TO_EMAIL;
  const fromEmail = process.env.FROM_EMAIL;

  if (!apiKey || !toEmail || !fromEmail) {
    return { sent: false, skipped: true };
  }

  const lines = [
    `Lead ID: ${lead.id}`,
    `Name: ${lead.name}`,
    `Email: ${lead.email}`,
    `Phone: ${lead.phone || '-'}`,
    `WhatsApp: ${lead.whatsapp || '-'}`,
    `Preferred Language: ${lead.language || '-'}`,
    `Budget: ${lead.budget || '-'}`,
    `WhatsApp Preferred: ${lead.contact_whatsapp ? 'yes' : 'no'}`,
    `Message: ${lead.message || '-'}`,
    `Submitted at: ${lead.createdAt}`,
  ];

  const html = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('');
  const text = lines.join('\n');

  const resendResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      reply_to: lead.email,
      subject: `New Amira lead - ${lead.name}`,
      html,
      text,
    }),
  });

  if (!resendResponse.ok) {
    const body = await resendResponse.text();
    throw new Error(`resend_failed:${resendResponse.status}:${body}`);
  }

  return { sent: true, skipped: false };
};

const parseLead = (payload) => {
  const name = sanitizeText(payload.name, 120);
  const email = sanitizeText(payload.email, 160);

  if (!name) {
    throw new Error('name_required');
  }
  if (!isEmail(email)) {
    throw new Error('email_invalid');
  }
  if (!payload.consent) {
    throw new Error('consent_required');
  }

  return {
    id: crypto.randomUUID(),
    name,
    email,
    phone: sanitizeText(payload.phone, 60),
    whatsapp: sanitizeText(payload.whatsapp, 60),
    budget: sanitizeText(payload.budget, 80),
    language: sanitizeText(payload.language || 'en', 10),
    message: sanitizeText(payload.message, 2000),
    contact_whatsapp: Boolean(payload.contact_whatsapp),
    consent: Boolean(payload.consent),
    createdAt: new Date().toISOString(),
    source: 'website',
  };
};

const serveStatic = async (requestPath, response) => {
  const normalizedPath = requestPath === '/' ? '/index.html' : requestPath;
  const safePath = normalizedPath.replace(/^\/+/, '');
  const absolutePath = path.join(ROOT, safePath);

  if (!absolutePath.startsWith(ROOT)) {
    safeJson(response, 403, { error: 'forbidden' });
    return;
  }

  try {
    const stats = await fsp.stat(absolutePath);
    if (!stats.isFile()) {
      safeJson(response, 404, { error: 'not_found' });
      return;
    }

    const extension = path.extname(absolutePath).toLowerCase();
    const type = MIME_TYPES[extension] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(absolutePath).pipe(response);
  } catch (error) {
    safeJson(response, 404, { error: 'not_found' });
  }
};

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    safeJson(response, 400, { error: 'bad_request' });
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/api/health') {
    safeJson(response, 200, { ok: true, date: new Date().toISOString() });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/public-config') {
    safeJson(response, 200, {
      whatsappNumber: process.env.SALES_WHATSAPP_NUMBER || '',
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/leads') {
    try {
      const rawBody = await readRequestBody(request);
      const payload = JSON.parse(rawBody || '{}');
      const lead = parseLead(payload);

      await persistLead(lead);
      await sendEmailWithResend(lead);

      safeJson(response, 201, { ok: true, leadId: lead.id });
      return;
    } catch (error) {
      if (error instanceof SyntaxError) {
        safeJson(response, 400, { ok: false, error: 'invalid_json' });
        return;
      }

      const codeByError = {
        payload_too_large: 413,
        name_required: 400,
        email_invalid: 400,
        consent_required: 400,
      };

      const key = String(error.message || 'internal_error').split(':')[0];
      const status = codeByError[key] || 500;
      safeJson(response, status, { ok: false, error: key });
      return;
    }
  }

  if (request.method !== 'GET') {
    safeJson(response, 405, { error: 'method_not_allowed' });
    return;
  }

  await serveStatic(url.pathname, response);
});

server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
