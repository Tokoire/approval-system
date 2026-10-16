const APPLICANT_NAME = '蔡朋成';
const APPROVER_NAME = '李佳恒';
const DEFAULT_CATEGORIES = ['经费申请', '物资申请', '活动申请', '请假申请', '权限申请', '其他申请'];
const MAX_IMAGE_COUNT = 3;
const MAX_IMAGE_CHARS = 480000;
const MAX_IMAGE_TOTAL_CHARS = 1350000;
let schemaReady = false;
let schemaPromise = null;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function cleanText(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function parseTimeline(value) {
  try { return JSON.parse(value || '[]'); }
  catch { return []; }
}

function parseImages(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToItem(row, includeImages = true) {
  return {
    id: row.id,
    displayId: row.display_id,
    applicant: row.applicant,
    approver: row.approver,
    title: row.title,
    category: row.category,
    urgency: row.urgency,
    contact: row.contact,
    details: row.details,
    status: row.status,
    feedback: row.feedback,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    timeline: parseTimeline(row.timeline),
    images: includeImages ? parseImages(row.images) : []
  };
}

async function buildSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      display_id TEXT NOT NULL,
      applicant TEXT NOT NULL,
      approver TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      urgency TEXT NOT NULL,
      contact TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL,
      status TEXT NOT NULL,
      feedback TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      timeline TEXT NOT NULL,
      images TEXT NOT NULL DEFAULT '[]'
    )
  `).run();

  // 兼容已经存在的旧数据库：若 applications 表还没有 images 列，则自动迁移。
  const columns = await db.prepare('PRAGMA table_info(applications)').all();
  const hasImages = (columns.results || []).some(c => c.name === 'images');
  if (!hasImages) {
    await db.prepare("ALTER TABLE applications ADD COLUMN images TEXT NOT NULL DEFAULT '[]'").run();
  }

  await db.prepare('CREATE INDEX IF NOT EXISTS idx_applications_created_at ON applications(created_at)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status)').run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS application_categories (
      name TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    )
  `).run();

  const categoryCount = await db.prepare('SELECT COUNT(*) AS count FROM application_categories').first();
  if (!categoryCount || Number(categoryCount.count) === 0) {
    const now = new Date().toISOString();
    await db.batch(DEFAULT_CATEGORIES.map(name =>
      db.prepare('INSERT OR IGNORE INTO application_categories (name, created_at) VALUES (?, ?)').bind(name, now)
    ));
  }
}

async function ensureSchema(db) {
  if (schemaReady) return;
  if (!schemaPromise) {
    schemaPromise = buildSchema(db)
      .then(() => { schemaReady = true; })
      .catch(error => { schemaPromise = null; throw error; });
  }
  await schemaPromise;
}

async function readBody(request) {
  try { return await request.json(); }
  catch { throw new Error('JSON 格式错误'); }
}

function normalizeImages(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('图片数据格式错误');
  if (value.length > MAX_IMAGE_COUNT) throw new Error(`最多上传 ${MAX_IMAGE_COUNT} 张图片`);

  let total = 0;
  const images = value.map((item) => {
    const data = String(item || '');
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data)) {
      throw new Error('图片格式无效，请重新选择图片');
    }
    if (data.length > MAX_IMAGE_CHARS) {
      throw new Error('单张图片压缩后仍然过大，请选择尺寸更小的图片');
    }
    total += data.length;
    return data;
  });

  if (total > MAX_IMAGE_TOTAL_CHARS) {
    throw new Error('图片总大小过大，请减少图片数量或选择尺寸更小的图片');
  }
  return images;
}

async function categoryExists(db, category) {
  const row = await db.prepare('SELECT name FROM application_categories WHERE name = ?').bind(category).first();
  return Boolean(row);
}

async function handleApi(request, env, url) {
  if (!env.DB) {
    return json({ message: '数据库尚未绑定。请检查名为 DB 的 D1 数据库绑定。' }, 503);
  }

  await ensureSchema(env.DB);
  const pathname = url.pathname;

  if (request.method === 'GET' && pathname === '/api/health') {
    return json({ ok: true, service: 'dual-approval-system-cloudflare-v2', time: new Date().toISOString() });
  }

  if (request.method === 'GET' && pathname === '/api/categories') {
    const result = await env.DB.prepare('SELECT name FROM application_categories ORDER BY created_at ASC, name ASC').all();
    return json((result.results || []).map(row => row.name));
  }

  if (request.method === 'POST' && pathname === '/api/categories') {
    const body = await readBody(request);
    const name = cleanText(body.name, 40);
    if (!name) return json({ message: '请输入申请类型名称' }, 400);

    const exists = await categoryExists(env.DB, name);
    if (exists) return json({ message: '该申请类型已存在' }, 409);

    await env.DB.prepare('INSERT INTO application_categories (name, created_at) VALUES (?, ?)')
      .bind(name, new Date().toISOString()).run();
    return json({ name }, 201);
  }

  const categoryDeleteMatch = pathname.match(/^\/api\/categories\/(.+)$/);
  if (request.method === 'DELETE' && categoryDeleteMatch) {
    let name;
    try { name = decodeURIComponent(categoryDeleteMatch[1]); }
    catch { return json({ message: '申请类型名称无效' }, 400); }
    name = cleanText(name, 40);
    if (!name) return json({ message: '申请类型名称无效' }, 400);

    const result = await env.DB.prepare('DELETE FROM application_categories WHERE name = ?').bind(name).run();
    if (!result.meta || result.meta.changes !== 1) return json({ message: '该申请类型不存在' }, 404);
    return json({ ok: true });
  }

  if (request.method === 'GET' && pathname === '/api/applications') {
    const status = cleanText(url.searchParams.get('status'), 20);
    const fields = `id, display_id, applicant, approver, title, category, urgency, contact,
                    details, status, feedback, created_at, reviewed_at, timeline`;
    let result;
    if (status) {
      result = await env.DB.prepare(
        `SELECT ${fields} FROM applications WHERE status = ? ORDER BY created_at DESC`
      ).bind(status).all();
    } else {
      result = await env.DB.prepare(
        `SELECT ${fields} FROM applications ORDER BY created_at DESC`
      ).all();
    }
    return json((result.results || []).map(row => rowToItem(row, false)));
  }

  const itemMatch = pathname.match(/^\/api\/applications\/([^/]+)$/);
  const reviewMatch = pathname.match(/^\/api\/applications\/([^/]+)\/review$/);

  if (request.method === 'GET' && itemMatch) {
    const row = await env.DB.prepare('SELECT * FROM applications WHERE id = ?')
      .bind(itemMatch[1]).first();
    return row ? json(rowToItem(row, true)) : json({ message: '申请不存在' }, 404);
  }

  if (request.method === 'POST' && pathname === '/api/applications') {
    const body = await readBody(request);
    const title = cleanText(body.title, 120);
    const category = cleanText(body.category, 60);
    const urgency = cleanText(body.urgency, 20) || '普通';
    const contact = cleanText(body.contact, 120);
    const details = cleanText(body.details, 3000);
    let images;
    try { images = normalizeImages(body.images); }
    catch (error) { return json({ message: error.message }, 400); }

    if (!title || !category || !details) {
      return json({ message: '申请标题、申请类型和申请内容为必填项' }, 400);
    }
    if (!(await categoryExists(env.DB, category))) {
      return json({ message: '该申请类型已被删除，请重新选择' }, 400);
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const item = {
      id,
      displayId: 'SQ-' + Date.now().toString().slice(-8),
      applicant: APPLICANT_NAME,
      approver: APPROVER_NAME,
      title,
      category,
      urgency,
      contact,
      details,
      status: 'pending',
      feedback: '',
      createdAt: now,
      reviewedAt: null,
      timeline: [{ action: 'submitted', actor: APPLICANT_NAME, at: now, note: '申请已提交，等待审批。' }],
      images
    };

    await env.DB.prepare(`
      INSERT INTO applications (
        id, display_id, applicant, approver, title, category, urgency,
        contact, details, status, feedback, created_at, reviewed_at, timeline, images
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      item.id, item.displayId, item.applicant, item.approver,
      item.title, item.category, item.urgency, item.contact, item.details,
      item.status, item.feedback, item.createdAt, item.reviewedAt,
      JSON.stringify(item.timeline), JSON.stringify(item.images)
    ).run();

    return json(item, 201);
  }

  if (request.method === 'POST' && reviewMatch) {
    const body = await readBody(request);
    const decision = cleanText(body.decision, 20);
    const feedback = cleanText(body.feedback, 2000);

    if (!['approved', 'rejected'].includes(decision)) {
      return json({ message: '无效的审批结果' }, 400);
    }
    if (!feedback) {
      return json({ message: '请填写审核理由' }, 400);
    }

    const id = reviewMatch[1];
    const current = await env.DB.prepare('SELECT * FROM applications WHERE id = ?')
      .bind(id).first();
    if (!current) return json({ message: '申请不存在' }, 404);
    if (current.status !== 'pending') {
      return json({ message: '该申请已经完成审批，不能重复审核' }, 409);
    }

    const now = new Date().toISOString();
    const timeline = parseTimeline(current.timeline);
    timeline.push({ action: decision, actor: APPROVER_NAME, at: now, note: feedback });

    const update = await env.DB.prepare(`
      UPDATE applications
      SET status = ?, feedback = ?, reviewed_at = ?, timeline = ?
      WHERE id = ? AND status = 'pending'
    `).bind(decision, feedback, now, JSON.stringify(timeline), id).run();

    if (!update.meta || update.meta.changes !== 1) {
      return json({ message: '该申请已经被其他操作完成审批，请刷新后查看' }, 409);
    }

    const updated = await env.DB.prepare('SELECT * FROM applications WHERE id = ?')
      .bind(id).first();
    return json(rowToItem(updated, true));
  }

  return json({ message: '接口不存在' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, url);
      }

      if (url.pathname === '/') {
        return Response.redirect(new URL('/applicant.html', url), 302);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ message: error?.message || '服务器内部错误' }, 500);
    }
  }
};
