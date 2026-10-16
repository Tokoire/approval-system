const APPLICANT_NAME = '蔡朋成';
const APPROVER_NAME = '李佳恒';

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

function rowToItem(row) {
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
    timeline: (() => {
      try { return JSON.parse(row.timeline || '[]'); }
      catch { return []; }
    })()
  };
}

async function ensureSchema(db) {
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
      timeline TEXT NOT NULL
    )
  `).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_applications_created_at ON applications(created_at)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status)').run();
}

async function readBody(request) {
  try { return await request.json(); }
  catch { throw new Error('JSON 格式错误'); }
}

async function handleApi(request, env, url) {
  if (!env.DB) {
    return json({ message: '数据库尚未绑定。请在 Cloudflare Pages 项目中添加名为 DB 的 D1 数据库绑定。' }, 503);
  }

  await ensureSchema(env.DB);
  const pathname = url.pathname;

  if (request.method === 'GET' && pathname === '/api/health') {
    return json({ ok: true, service: 'dual-approval-system-cloudflare', time: new Date().toISOString() });
  }

  if (request.method === 'GET' && pathname === '/api/applications') {
    const status = cleanText(url.searchParams.get('status'), 20);
    let result;
    if (status) {
      result = await env.DB.prepare(
        'SELECT * FROM applications WHERE status = ? ORDER BY created_at DESC'
      ).bind(status).all();
    } else {
      result = await env.DB.prepare(
        'SELECT * FROM applications ORDER BY created_at DESC'
      ).all();
    }
    return json((result.results || []).map(rowToItem));
  }

  const itemMatch = pathname.match(/^\/api\/applications\/([^/]+)$/);
  const reviewMatch = pathname.match(/^\/api\/applications\/([^/]+)\/review$/);

  if (request.method === 'GET' && itemMatch) {
    const row = await env.DB.prepare('SELECT * FROM applications WHERE id = ?')
      .bind(itemMatch[1]).first();
    return row ? json(rowToItem(row)) : json({ message: '申请不存在' }, 404);
  }

  if (request.method === 'POST' && pathname === '/api/applications') {
    const body = await readBody(request);
    const title = cleanText(body.title, 120);
    const category = cleanText(body.category, 60);
    const urgency = cleanText(body.urgency, 20) || '普通';
    const contact = cleanText(body.contact, 120);
    const details = cleanText(body.details, 3000);

    if (!title || !category || !details) {
      return json({ message: '申请标题、申请类型和申请内容为必填项' }, 400);
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
      timeline: [{ action: 'submitted', actor: APPLICANT_NAME, at: now, note: '申请已提交，等待审批。' }]
    };

    await env.DB.prepare(`
      INSERT INTO applications (
        id, display_id, applicant, approver, title, category, urgency,
        contact, details, status, feedback, created_at, reviewed_at, timeline
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      item.id, item.displayId, item.applicant, item.approver,
      item.title, item.category, item.urgency, item.contact, item.details,
      item.status, item.feedback, item.createdAt, item.reviewedAt,
      JSON.stringify(item.timeline)
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
    let timeline;
    try { timeline = JSON.parse(current.timeline || '[]'); }
    catch { timeline = []; }
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
    return json(rowToItem(updated));
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
