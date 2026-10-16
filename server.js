const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = __dirname;
const DATA_FILE = path.join(__dirname, 'applications.json');
const APPLICANT_NAME = '蔡朋成';
const APPROVER_NAME = '李佳恒';

function ensureDataFile() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
}
function readApplications() {
  ensureDataFile();
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '[]'); }
  catch { return []; }
}
function writeApplications(items) {
  ensureDataFile();
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}
function cleanText(value, max = 2000) { return String(value ?? '').trim().slice(0, max); }
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error('请求内容过大'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}
function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/applicant.html' : pathname;
  const decoded = decodeURIComponent(requested);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, normalized);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { message: '禁止访问' });
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendJson(res, 404, { message: '页面不存在' });
  const ext = path.extname(filePath).toLowerCase();
  const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, service: 'dual-approval-system', time: new Date().toISOString() });
    }

    if (req.method === 'GET' && pathname === '/api/applications') {
      const items = readApplications();
      const status = cleanText(url.searchParams.get('status'), 20);
      const filtered = status ? items.filter(x => x.status === status) : items;
      filtered.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
      return sendJson(res, 200, filtered);
    }

    const itemMatch = pathname.match(/^\/api\/applications\/([^/]+)$/);
    const reviewMatch = pathname.match(/^\/api\/applications\/([^/]+)\/review$/);

    if (req.method === 'GET' && itemMatch) {
      const item = readApplications().find(x => x.id === itemMatch[1]);
      return item ? sendJson(res, 200, item) : sendJson(res, 404, { message: '申请不存在' });
    }

    if (req.method === 'POST' && pathname === '/api/applications') {
      const body = await readJson(req);
      const title = cleanText(body.title, 120);
      const category = cleanText(body.category, 60);
      const urgency = cleanText(body.urgency, 20) || '普通';
      const contact = cleanText(body.contact, 120);
      const details = cleanText(body.details, 3000);
      if (!title || !category || !details) return sendJson(res, 400, { message: '申请标题、申请类型和申请内容为必填项' });
      const now = new Date().toISOString();
      const item = {
        id: crypto.randomUUID(),
        displayId: 'SQ-' + Date.now().toString().slice(-8),
        applicant: APPLICANT_NAME,
        approver: APPROVER_NAME,
        title, category, urgency, contact, details,
        status: 'pending', feedback: '', createdAt: now, reviewedAt: null,
        timeline: [{ action:'submitted', actor:APPLICANT_NAME, at:now, note:'申请已提交，等待审批。' }]
      };
      const items = readApplications();
      items.push(item); writeApplications(items);
      return sendJson(res, 201, item);
    }

    if (req.method === 'POST' && reviewMatch) {
      const body = await readJson(req);
      const decision = cleanText(body.decision, 20);
      const feedback = cleanText(body.feedback, 2000);
      if (!['approved','rejected'].includes(decision)) return sendJson(res, 400, { message: '无效的审批结果' });
      if (!feedback) return sendJson(res, 400, { message: '请填写审核理由' });
      const items = readApplications();
      const index = items.findIndex(x => x.id === reviewMatch[1]);
      if (index === -1) return sendJson(res, 404, { message: '申请不存在' });
      if (items[index].status !== 'pending') return sendJson(res, 409, { message: '该申请已经完成审批，不能重复审核' });
      const now = new Date().toISOString();
      items[index].status = decision;
      items[index].feedback = feedback;
      items[index].reviewedAt = now;
      items[index].timeline.push({ action:decision, actor:APPROVER_NAME, at:now, note:feedback });
      writeApplications(items);
      return sendJson(res, 200, items[index]);
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { message: '接口不存在' });
    if (req.method === 'GET') return serveStatic(res, pathname);
    return sendJson(res, 405, { message: '请求方法不支持' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { message: error.message || '服务器内部错误' });
  }
});

ensureDataFile();
server.listen(PORT, HOST, () => {
  console.log(`审批系统已启动：http://localhost:${PORT}`);
  console.log(`申请端：http://localhost:${PORT}/applicant.html`);
  console.log(`审批端：http://localhost:${PORT}/approver.html`);
});
