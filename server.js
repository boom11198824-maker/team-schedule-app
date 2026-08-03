/* =========================================================================
 * 팀 스케줄 앱 - 단일 파일 서버
 * (GitHub 웹사이트에서 파일을 쉽게 올릴 수 있도록 모든 백엔드 코드를
 *  server.js 한 파일에 모아뒀습니다. 기능은 원본과 완전히 동일합니다.)
 * ========================================================================= */

require('dotenv').config({ quiet: true });

const express = require('express');
const session = require('express-session');
const Sqlite = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);
const bcrypt = require('bcryptjs');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

/* ------------------------------------------------------------------ */
/* 데이터베이스                                                        */
/* ------------------------------------------------------------------ */

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Sqlite(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  assignee_name TEXT,
  category TEXT NOT NULL DEFAULT '업무',
  created_by INTEGER NOT NULL,
  google_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES employees(id)
);

CREATE TABLE IF NOT EXISTS google_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token TEXT,
  access_token TEXT,
  token_expiry INTEGER,
  calendar_id TEXT,
  calendar_summary TEXT,
  connected_by INTEGER,
  connected_at TEXT
);

CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_name TEXT NOT NULL,
  phone TEXT,
  court TEXT,
  court_case_no TEXT,
  assignee_name TEXT,
  memo TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES employees(id)
);

CREATE TABLE IF NOT EXISTS case_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  task_type TEXT NOT NULL,
  received_date TEXT,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '예정',
  assignee_name TEXT,
  memo TEXT,
  created_by INTEGER NOT NULL,
  google_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (case_id) REFERENCES cases(id),
  FOREIGN KEY (created_by) REFERENCES employees(id)
);

CREATE INDEX IF NOT EXISTS idx_case_tasks_case_id ON case_tasks(case_id);
CREATE INDEX IF NOT EXISTS idx_case_tasks_due_date ON case_tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_case_tasks_status ON case_tasks(status);
`);

// 구글시트 내보내기(백업/공유용) 정보를 저장할 컬럼 - 기존 DB에 없으면 추가
try {
  db.exec("ALTER TABLE google_auth ADD COLUMN sheets_spreadsheet_id TEXT");
} catch (err) {
  if (!String(err.message).includes('duplicate column')) throw err;
}
try {
  db.exec("ALTER TABLE google_auth ADD COLUMN sheets_last_synced_at TEXT");
} catch (err) {
  if (!String(err.message).includes('duplicate column')) throw err;
}
try {
  db.exec("ALTER TABLE case_tasks ADD COLUMN received_date TEXT");
} catch (err) {
  if (!String(err.message).includes('duplicate column')) throw err;
}
try {
  db.exec("ALTER TABLE google_auth ADD COLUMN tasks_source TEXT");
} catch (err) {
  if (!String(err.message).includes('duplicate column')) throw err;
}

// 기존 DB에 category 컬럼이 없는 경우를 위한 마이그레이션 (이미 있으면 조용히 무시)
try {
  db.exec("ALTER TABLE schedules ADD COLUMN category TEXT NOT NULL DEFAULT '업무'");
} catch (err) {
  if (!String(err.message).includes('duplicate column')) throw err;
}

/* ------------------------------------------------------------------ */
/* 인증 / 권한                                                         */
/* ------------------------------------------------------------------ */

function hashPassword(plain) { return bcrypt.hashSync(plain, 10); }
function verifyPassword(plain, hash) { return bcrypt.compareSync(plain, hash); }
function findByUsername(username) { return db.prepare('SELECT * FROM employees WHERE username = ?').get(username); }
function findById(id) { return db.prepare('SELECT * FROM employees WHERE id = ?').get(id); }

function ensureAdminSeed() {
  const adminCount = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE role = 'admin'").get().c;
  if (adminCount > 0) return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (!password) {
    password = Math.random().toString(36).slice(-10);
    generated = true;
  }
  const name = process.env.ADMIN_NAME || '관리자';
  const email = process.env.ADMIN_EMAIL || '';

  const existing = findByUsername(username);
  if (existing) {
    db.prepare("UPDATE employees SET role = 'admin' WHERE id = ?").run(existing.id);
    return;
  }

  db.prepare(
    `INSERT INTO employees (username, email, password_hash, name, role) VALUES (?, ?, ?, ?, 'admin')`
  ).run(username, email, hashPassword(password), name);

  console.log('====================================================');
  console.log('관리자 계정이 생성되었습니다.');
  console.log(`  아이디: ${username}`);
  if (generated) {
    console.log(`  비밀번호(자동생성): ${password}`);
    console.log('  -> 반드시 로그인 후 비밀번호를 변경하거나, 환경변수 ADMIN_PASSWORD 값을 설정하세요.');
  } else {
    console.log('  비밀번호: 환경변수 ADMIN_PASSWORD 값');
  }
  console.log('====================================================');
}
ensureAdminSeed();

function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  const user = findById(req.session.userId);
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireLogin(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: '관리자만 사용할 수 있는 기능입니다.' });
    }
    next();
  });
}

/* ------------------------------------------------------------------ */
/* 구글 캘린더 연동                                                     */
/* ------------------------------------------------------------------ */

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI 환경변수가 설정되지 않았습니다.');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getGoogleAuthUrl() {
  const client = getOAuthClient();
  return client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: GOOGLE_SCOPES });
}

function getStoredGoogleAuth() { return db.prepare('SELECT * FROM google_auth WHERE id = 1').get(); }
function isGoogleConnected() { const row = getStoredGoogleAuth(); return !!(row && row.refresh_token); }

async function handleGoogleOAuthCallback(code, adminUserId) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const calendar = google.calendar({ version: 'v3', auth: client });
  const calendarSummary = process.env.GOOGLE_CALENDAR_NAME || '팀 일정 (스케줄 앱)';

  let calendarId = null;
  const list = await calendar.calendarList.list();
  const found = (list.data.items || []).find((c) => c.summary === calendarSummary);
  if (found) {
    calendarId = found.id;
  } else {
    const created = await calendar.calendars.insert({ requestBody: { summary: calendarSummary, timeZone: 'Asia/Seoul' } });
    calendarId = created.data.id;
  }

  const existing = getStoredGoogleAuth();
  db.prepare(
    `INSERT INTO google_auth (id, refresh_token, access_token, token_expiry, calendar_id, calendar_summary, connected_by, connected_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       refresh_token = excluded.refresh_token, access_token = excluded.access_token,
       token_expiry = excluded.token_expiry, calendar_id = excluded.calendar_id,
       calendar_summary = excluded.calendar_summary, connected_by = excluded.connected_by,
       connected_at = excluded.connected_at`
  ).run(
    tokens.refresh_token || (existing && existing.refresh_token) || null,
    tokens.access_token || null,
    tokens.expiry_date || null,
    calendarId,
    calendarSummary,
    adminUserId
  );

  return { calendarId, calendarSummary };
}

function disconnectGoogle() { db.prepare('DELETE FROM google_auth WHERE id = 1').run(); }

async function getAuthorizedGoogleClient() {
  const row = getStoredGoogleAuth();
  if (!row || !row.refresh_token) return null;
  const client = getOAuthClient();
  client.setCredentials({ refresh_token: row.refresh_token, access_token: row.access_token });
  client.on('tokens', (tokens) => {
    if (tokens.access_token) {
      db.prepare('UPDATE google_auth SET access_token = ?, token_expiry = ? WHERE id = 1').run(
        tokens.access_token, tokens.expiry_date || null
      );
    }
  });
  return client;
}

function addDaysToDateString(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toGoogleEvent(schedule) {
  const categoryPrefix = schedule.category && schedule.category !== '업무' ? `[${schedule.category}] ` : '';
  const event = {
    summary: `${categoryPrefix}${schedule.title}`,
    description: [
      schedule.category ? `종류: ${schedule.category}` : null,
      schedule.description,
      schedule.assignee_name ? `담당자: ${schedule.assignee_name}` : null,
    ].filter(Boolean).join('\n'),
    location: schedule.location || undefined,
  };
  if (schedule.all_day) {
    event.start = { date: schedule.start_at.slice(0, 10) };
    event.end = { date: addDaysToDateString(schedule.end_at.slice(0, 10), 1) };
  } else {
    event.start = { dateTime: schedule.start_at, timeZone: 'Asia/Seoul' };
    event.end = { dateTime: schedule.end_at, timeZone: 'Asia/Seoul' };
  }
  return event;
}

async function googleCreateEvent(schedule) {
  const client = await getAuthorizedGoogleClient();
  if (!client) return null;
  const row = getStoredGoogleAuth();
  const calendar = google.calendar({ version: 'v3', auth: client });
  const res = await calendar.events.insert({ calendarId: row.calendar_id, requestBody: toGoogleEvent(schedule) });
  return res.data.id;
}

async function googleUpdateEvent(googleEventId, schedule) {
  const client = await getAuthorizedGoogleClient();
  if (!client || !googleEventId) return;
  const row = getStoredGoogleAuth();
  const calendar = google.calendar({ version: 'v3', auth: client });
  try {
    await calendar.events.update({ calendarId: row.calendar_id, eventId: googleEventId, requestBody: toGoogleEvent(schedule) });
  } catch (err) {
    if (err.code === 404 || err.code === 410) return googleCreateEvent(schedule);
    throw err;
  }
}

async function googleDeleteEvent(googleEventId) {
  const client = await getAuthorizedGoogleClient();
  if (!client || !googleEventId) return;
  const row = getStoredGoogleAuth();
  const calendar = google.calendar({ version: 'v3', auth: client });
  try {
    await calendar.events.delete({ calendarId: row.calendar_id, eventId: googleEventId });
  } catch (err) {
    if (err.code !== 404 && err.code !== 410) throw err;
  }
}

async function googleShareCalendar(email) {
  if (!email) return;
  const client = await getAuthorizedGoogleClient();
  if (!client) return;
  const row = getStoredGoogleAuth();
  const calendar = google.calendar({ version: 'v3', auth: client });
  await calendar.acl.insert({ calendarId: row.calendar_id, requestBody: { role: 'reader', scope: { type: 'user', value: email } } });
}

async function googleUnshareCalendar(email) {
  if (!email) return;
  const client = await getAuthorizedGoogleClient();
  if (!client) return;
  const row = getStoredGoogleAuth();
  const calendar = google.calendar({ version: 'v3', auth: client });
  try {
    await calendar.acl.delete({ calendarId: row.calendar_id, ruleId: `user:${email}` });
  } catch (err) {
    if (err.code !== 404) throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 구글 시트 연동 (사건목록: 앱이 관리 / 일정_보정관리: 직원이 시트에서 직접 입력) */
/* ------------------------------------------------------------------ */
/* [사건목록] 탭은 계속 이 앱(SQLite)이 원본이며, 내보내기 버튼을 누를 때마다
 * 최신 사건 목록으로 갱신됩니다. 관리자/직원이 참고용으로 열람하는 용도입니다.
 *
 * [일정_보정관리] 탭은 스프레드시트가 처음 만들어질 때 딱 한 번 현재 데이터로
 * 시드(seed)된 뒤에는 절대 앱이 덮어쓰지 않습니다 - 그 이후로는 직원이 시트에
 * 직접 행을 추가/수정하는 것이 원본(source of truth)이 되고, 관리자 대시보드는
 * 이 탭을 실시간으로 읽어와 보여줍니다 (읽기 전용 뷰).
 *
 * 직원이 매번 사건ID를 찾아 입력하는 번거로움을 없애기 위해, 사건을 찾는 키는
 * "의뢰인명"입니다 (동명이인이 있을 때만 선택적으로 사건번호를 같이 적으면 됨).
 * 서류에 인쇄된 이름/사건번호를 그대로 옮겨 적으면 되므로 앱 전용 ID를 외우거나
 * 다른 탭을 오가며 찾아볼 필요가 없습니다. */

const SHEETS_TITLE_CASES = '사건목록';
const SHEETS_TITLE_TASKS = '일정_보정관리';
// 직원이 실제로 채우는 건 의뢰인명·업무구분·마감예정일 3개뿐이고 나머지는 선택 사항
const TASKS_SHEET_HEADER = ['의뢰인명 *', '업무구분/서류명 *', '수령일', '마감예정일 *', '처리상태', '담당자', '사건번호(동명이인 있을 때만)', '메모'];

async function getSheetsAuthorizedClient() {
  return getAuthorizedGoogleClient();
}

function caseIdToken(id) { return `CASE_${String(id).padStart(3, '0')}`; }

function buildCasesSheetRows() {
  const rows = db.prepare('SELECT * FROM cases ORDER BY id ASC').all();
  const header = ['사건ID', '의뢰인명', '연락처', '관할법원', '사건번호', '담당직원', '메모', '등록일'];
  const body = rows.map((c) => [
    caseIdToken(c.id),
    c.client_name || '', c.phone || '', c.court || '', c.court_case_no || '',
    c.assignee_name || '', c.memo || '', c.created_at || '',
  ]);
  return [header, ...body];
}

function buildTasksSeedRows() {
  const rows = db.prepare(`
    SELECT t.*, c.client_name AS client_name, c.court_case_no AS court_case_no
    FROM case_tasks t LEFT JOIN cases c ON c.id = t.case_id
    ORDER BY t.due_date ASC
  `).all();
  const body = rows.map((t) => [
    t.client_name || '', t.task_type || '', t.received_date || '', t.due_date || '',
    t.status || '', t.assignee_name || '', t.court_case_no || '', t.memo || '',
  ]);
  return [TASKS_SHEET_HEADER, ...body];
}

async function shareSheetWithStaff(sheets, spreadsheetId, client) {
  const emails = db.prepare("SELECT email FROM employees WHERE email IS NOT NULL AND email != ''").all().map((r) => r.email);
  if (!emails.length) return;
  const drive = google.drive({ version: 'v3', auth: client });
  for (const email of emails) {
    try {
      await drive.permissions.create({
        fileId: spreadsheetId,
        sendNotificationEmail: false,
        requestBody: { type: 'user', role: 'writer', emailAddress: email },
      });
    } catch (err) {
      console.error(`구글시트 공유 실패 (${email}):`, err.message);
    }
  }
}

// 사건목록 탭은 매번 최신화하고, 일정_보정관리 탭은 스프레드시트가 처음 만들어질 때만
// 시드로 채운다. 그 이후 이 함수를 다시 호출해도 일정_보정관리 탭은 건드리지 않는다
// (직원이 시트에 입력해둔 내용을 앱이 덮어써서 날려버리는 사고를 막기 위함).
async function exportCasesToGoogleSheet() {
  const client = await getSheetsAuthorizedClient();
  if (!client) {
    const err = new Error('구글 계정이 연동되어 있지 않습니다. 먼저 구글 캘린더 연동을 진행해주세요.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const sheets = google.sheets({ version: 'v4', auth: client });
  const authRow = getStoredGoogleAuth();
  let spreadsheetId = authRow && authRow.sheets_spreadsheet_id;
  const isFirstTime = !spreadsheetId;

  try {
    if (isFirstTime) {
      const created = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: '사건관리 데이터 (팀 스케줄 앱 연동)' },
          sheets: [
            { properties: { title: SHEETS_TITLE_CASES } },
            { properties: { title: SHEETS_TITLE_TASKS } },
          ],
        },
      });
      spreadsheetId = created.data.spreadsheetId;
      db.prepare("UPDATE google_auth SET sheets_spreadsheet_id = ?, tasks_source = 'sheet' WHERE id = 1").run(spreadsheetId);

      // 일정_보정관리 탭: 이번 한 번만 현재 데이터로 시드. 이후로는 직원이 시트에서 직접 관리.
      const tasksSeed = buildTasksSeedRows();
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: `${SHEETS_TITLE_TASKS}!A1`, valueInputOption: 'RAW', requestBody: { values: tasksSeed },
      });

      await shareSheetWithStaff(sheets, spreadsheetId, client);
    }

    // 사건목록 탭: 항상 최신 사건 목록으로 갱신 (직원이 사건ID를 찾아 쓸 수 있도록)
    const casesRows = buildCasesSheetRows();
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${SHEETS_TITLE_CASES}!A1:Z100000` });
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${SHEETS_TITLE_CASES}!A1`, valueInputOption: 'RAW', requestBody: { values: casesRows },
    });

    const syncedAt = new Date().toISOString();
    db.prepare('UPDATE google_auth SET sheets_last_synced_at = ? WHERE id = 1').run(syncedAt);

    return {
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      syncedAt,
      caseCount: casesRows.length - 1,
      firstTime: isFirstTime,
    };
  } catch (err) {
    // 기존에 연동된 계정이 (구)캘린더 권한만 갖고 있어 시트 권한이 없는 경우
    if (err.code === 403 || /insufficient|permission/i.test(err.message || '')) {
      const wrapped = new Error('구글 계정에 스프레드시트 권한이 없습니다. "구글 캘린더 연동"에서 다시 연결해주세요 (시트/드라이브 권한이 추가되었습니다).');
      wrapped.code = 'NEEDS_RECONSENT';
      throw wrapped;
    }
    throw err;
  }
}

function normalizeMatchKey(s) { return String(s || '').trim().replace(/\s+/g, ''); }

// 의뢰인명(+선택적으로 사건번호)으로 사건을 찾는다. 동명이인이 여러 명이면
// 사건번호가 일치하는 쪽을 우선하고, 그래도 못 정하면 가장 최근에 등록된 사건을 사용.
function matchCaseByNameAndCaseNo(cases, clientName, courtCaseNo) {
  const nameKey = normalizeMatchKey(clientName);
  if (!nameKey) return null;
  const candidates = cases.filter((c) => normalizeMatchKey(c.client_name) === nameKey);
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  const caseNoKey = normalizeMatchKey(courtCaseNo);
  if (caseNoKey) {
    const exact = candidates.find((c) => normalizeMatchKey(c.court_case_no) === caseNoKey);
    if (exact) return exact;
  }
  return candidates.reduce((latest, c) => (c.id > latest.id ? c : latest), candidates[0]);
}

// 관리자 대시보드용: 일정_보정관리 탭을 실시간으로 읽어와 case_tasks와 같은 모양으로 변환.
// 시트가 연동되어 있지 않으면 null을 반환해서 호출 측이 SQLite로 폴백하도록 한다.
async function readTasksFromSheetIfConnected() {
  const authRow = getStoredGoogleAuth();
  if (!authRow || !authRow.sheets_spreadsheet_id || authRow.tasks_source !== 'sheet') return null;

  const client = await getSheetsAuthorizedClient();
  if (!client) return null;

  const sheets = google.sheets({ version: 'v4', auth: client });
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: authRow.sheets_spreadsheet_id,
    range: `${SHEETS_TITLE_TASKS}!A2:H100000`,
  });
  const rows = resp.data.values || [];
  const cases = db.prepare('SELECT * FROM cases').all();

  const tasks = [];
  let skipped = 0;
  rows.forEach((row, i) => {
    const [clientNameRaw, taskType, receivedDate, dueDate, statusRaw, assignee, courtCaseNoRaw, memo] = row;
    if (!clientNameRaw || !taskType || !dueDate) { if ((row || []).some(Boolean)) skipped++; return; }

    const matchedCase = matchCaseByNameAndCaseNo(cases, clientNameRaw, courtCaseNoRaw);
    const status = CASE_TASK_STATUSES.includes(statusRaw) ? statusRaw : '예정';
    tasks.push({
      id: `sheet-${i}`,
      source: 'sheet',
      sheetRow: i + 2,
      case_id: matchedCase ? matchedCase.id : null,
      matched: !!matchedCase,
      task_type: taskType,
      received_date: receivedDate || '',
      due_date: dueDate,
      status,
      assignee_name: assignee || (matchedCase && matchedCase.assignee_name) || '',
      memo: memo || '',
      client_name: clientNameRaw,
      court: (matchedCase && matchedCase.court) || '',
      court_case_no: (matchedCase && matchedCase.court_case_no) || courtCaseNoRaw || '',
    });
  });

  if (skipped > 0) console.warn(`구글시트 일정_보정관리: 형식이 맞지 않아 건너뛴 행 ${skipped}건 (의뢰인명/업무구분/마감예정일 확인 필요)`);
  return tasks;
}

/* ------------------------------------------------------------------ */
/* Express 앱                                                          */
/* ------------------------------------------------------------------ */

const sessionDb = new Sqlite(path.join(DATA_DIR, 'sessions.db'));

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

app.use(
  session({
    store: new SqliteStore({ client: sessionDb, expired: { clear: true, intervalMs: 900000 } }),
    secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 14,
      secure: process.env.NODE_ENV === 'production' && process.env.DISABLE_SECURE_COOKIE !== 'true',
      sameSite: 'lax',
    },
  })
);

/* ---- /api/auth ---- */

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  const user = findByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }
  req.session.userId = user.id;
  res.json({ id: user.id, username: user.username, name: user.name, role: user.role });
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/api/auth/me', requireLogin, (req, res) => {
  const { id, username, name, role, email } = req.user;
  res.json({ id, username, name, role, email });
});

app.post('/api/auth/change-password', requireLogin, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: '현재 비밀번호와 4자 이상의 새 비밀번호를 입력해주세요.' });
  }
  if (!verifyPassword(currentPassword, req.user.password_hash)) {
    return res.status(401).json({ error: '현재 비밀번호가 올바르지 않습니다.' });
  }
  db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

/* ---- /api/employees ---- */

app.get('/api/employees', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT id, username, email, name, role FROM employees ORDER BY id').all());
});

app.post('/api/employees', requireAdmin, async (req, res) => {
  const { username, password, name, email, role } = req.body || {};
  if (!username || !password || !name) return res.status(400).json({ error: '아이디, 비밀번호, 이름은 필수입니다.' });
  try {
    const info = db
      .prepare(`INSERT INTO employees (username, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)`)
      .run(username, email || '', hashPassword(password), name, role === 'admin' ? 'admin' : 'employee');

    if (email && isGoogleConnected()) {
      try { await googleShareCalendar(email); } catch (e) { console.error('구글 캘린더 공유 실패:', e.message); }
    }
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
    res.status(500).json({ error: '직원 등록 중 오류가 발생했습니다.' });
  }
});

app.patch('/api/employees/:id', requireAdmin, (req, res) => {
  const { name, email, password, role } = req.body || {};
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: '직원을 찾을 수 없습니다.' });

  const fields = [];
  const values = [];
  if (name) { fields.push('name = ?'); values.push(name); }
  if (email !== undefined) { fields.push('email = ?'); values.push(email); }
  if (role) { fields.push('role = ?'); values.push(role === 'admin' ? 'admin' : 'employee'); }
  if (password) { fields.push('password_hash = ?'); values.push(hashPassword(password)); }
  if (!fields.length) return res.json({ ok: true });

  values.push(req.params.id);
  db.prepare(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

app.delete('/api/employees/:id', requireAdmin, async (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: '직원을 찾을 수 없습니다.' });
  if (emp.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) c FROM employees WHERE role='admin'").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: '마지막 관리자 계정은 삭제할 수 없습니다.' });
  }
  db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
  if (emp.email && isGoogleConnected()) {
    try { await googleUnshareCalendar(emp.email); } catch (e) { console.error('구글 캘린더 공유 해제 실패:', e.message); }
  }
  res.json({ ok: true });
});

/* ---- /api/schedules ---- */

function canModifySchedule(user, schedule) { return user.role === 'admin' || schedule.created_by === user.id; }

app.get('/api/schedules', requireLogin, (req, res) => {
  const { start, end } = req.query;
  let rows;
  if (start && end) {
    rows = db
      .prepare(`SELECT s.*, e.name AS creator_name FROM schedules s JOIN employees e ON e.id = s.created_by
                WHERE s.start_at < ? AND s.end_at > ? ORDER BY s.start_at`)
      .all(end, start);
  } else {
    rows = db
      .prepare(`SELECT s.*, e.name AS creator_name FROM schedules s JOIN employees e ON e.id = s.created_by ORDER BY s.start_at`)
      .all();
  }
  res.json(rows);
});

const SCHEDULE_CATEGORIES = ['업무', '보정', '상담', '휴가', '기타'];

app.post('/api/schedules', requireLogin, async (req, res) => {
  const { title, description, location, start_at, end_at, all_day, assignee_name, category } = req.body || {};
  if (!title || !start_at || !end_at) return res.status(400).json({ error: '제목, 시작일시, 종료일시는 필수입니다.' });
  const safeCategory = SCHEDULE_CATEGORIES.includes(category) ? category : '업무';

  const info = db
    .prepare(`INSERT INTO schedules (title, description, location, start_at, end_at, all_day, assignee_name, category, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(title, description || '', location || '', start_at, end_at, all_day ? 1 : 0, assignee_name || '', safeCategory, req.user.id);

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(info.lastInsertRowid);

  try {
    const googleEventId = await googleCreateEvent(schedule);
    if (googleEventId) {
      db.prepare('UPDATE schedules SET google_event_id = ? WHERE id = ?').run(googleEventId, schedule.id);
      schedule.google_event_id = googleEventId;
    }
  } catch (err) { console.error('구글 캘린더 등록 실패:', err.message); }

  res.status(201).json(schedule);
});

app.put('/api/schedules/:id', requireLogin, async (req, res) => {
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  if (!schedule) return res.status(404).json({ error: '일정을 찾을 수 없습니다.' });
  if (!canModifySchedule(req.user, schedule)) return res.status(403).json({ error: '본인이 등록한 일정만 수정할 수 있습니다.' });

  const { title, description, location, start_at, end_at, all_day, assignee_name, category } = req.body || {};
  const updated = {
    title: title ?? schedule.title,
    description: description ?? schedule.description,
    location: location ?? schedule.location,
    start_at: start_at ?? schedule.start_at,
    end_at: end_at ?? schedule.end_at,
    all_day: all_day === undefined ? schedule.all_day : (all_day ? 1 : 0),
    assignee_name: assignee_name ?? schedule.assignee_name,
    category: SCHEDULE_CATEGORIES.includes(category) ? category : schedule.category,
  };

  db.prepare(
    `UPDATE schedules SET title=?, description=?, location=?, start_at=?, end_at=?, all_day=?, assignee_name=?, category=?, updated_at=datetime('now') WHERE id = ?`
  ).run(updated.title, updated.description, updated.location, updated.start_at, updated.end_at, updated.all_day, updated.assignee_name, updated.category, schedule.id);

  const fresh = db.prepare('SELECT * FROM schedules WHERE id = ?').get(schedule.id);

  try {
    if (fresh.google_event_id) {
      await googleUpdateEvent(fresh.google_event_id, fresh);
    } else {
      const googleEventId = await googleCreateEvent(fresh);
      if (googleEventId) {
        db.prepare('UPDATE schedules SET google_event_id = ? WHERE id = ?').run(googleEventId, fresh.id);
        fresh.google_event_id = googleEventId;
      }
    }
  } catch (err) { console.error('구글 캘린더 수정 실패:', err.message); }

  res.json(fresh);
});

app.delete('/api/schedules/:id', requireLogin, async (req, res) => {
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  if (!schedule) return res.status(404).json({ error: '일정을 찾을 수 없습니다.' });
  if (!canModifySchedule(req.user, schedule)) return res.status(403).json({ error: '본인이 등록한 일정만 삭제할 수 있습니다.' });

  db.prepare('DELETE FROM schedules WHERE id = ?').run(schedule.id);

  try {
    if (schedule.google_event_id) await googleDeleteEvent(schedule.google_event_id);
  } catch (err) { console.error('구글 캘린더 삭제 실패:', err.message); }

  res.json({ ok: true });
});

/* ---- /api/cases (사건 관리) ---- */

app.get('/api/cases', requireLogin, (req, res) => {
  res.json(db.prepare('SELECT * FROM cases ORDER BY id DESC').all());
});

app.post('/api/cases', requireLogin, (req, res) => {
  const { client_name, phone, court, court_case_no, assignee_name, memo } = req.body || {};
  if (!client_name) return res.status(400).json({ error: '의뢰인명은 필수입니다.' });

  const info = db
    .prepare(`INSERT INTO cases (client_name, phone, court, court_case_no, assignee_name, memo, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(client_name, phone || '', court || '', court_case_no || '', assignee_name || '', memo || '', req.user.id);

  res.status(201).json(db.prepare('SELECT * FROM cases WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/cases/:id', requireLogin, (req, res) => {
  const existing = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  const { client_name, phone, court, court_case_no, assignee_name, memo } = req.body || {};
  const updated = {
    client_name: client_name ?? existing.client_name,
    phone: phone ?? existing.phone,
    court: court ?? existing.court,
    court_case_no: court_case_no ?? existing.court_case_no,
    assignee_name: assignee_name ?? existing.assignee_name,
    memo: memo ?? existing.memo,
  };
  db.prepare(`UPDATE cases SET client_name=?, phone=?, court=?, court_case_no=?, assignee_name=?, memo=? WHERE id = ?`)
    .run(updated.client_name, updated.phone, updated.court, updated.court_case_no, updated.assignee_name, updated.memo, existing.id);

  res.json(db.prepare('SELECT * FROM cases WHERE id = ?').get(existing.id));
});

app.delete('/api/cases/:id', requireLogin, async (req, res) => {
  const existing = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  const tasks = db.prepare('SELECT * FROM case_tasks WHERE case_id = ?').all(existing.id);
  for (const t of tasks) {
    try { if (t.google_event_id) await googleDeleteEvent(t.google_event_id); } catch (err) { console.error('구글 캘린더 삭제 실패:', err.message); }
  }
  db.prepare('DELETE FROM case_tasks WHERE case_id = ?').run(existing.id);
  db.prepare('DELETE FROM cases WHERE id = ?').run(existing.id);

  res.json({ ok: true });
});

/* ---- /api/case-tasks (사건별 서류/보정 일정) ---- */

const CASE_TASK_STATUSES = ['예정', '진행중', '완료'];

function caseTaskWithCase(task) {
  const c = db.prepare('SELECT client_name, court, court_case_no FROM cases WHERE id = ?').get(task.case_id) || {};
  return Object.assign({}, task, {
    client_name: c.client_name || '',
    court: c.court || '',
    court_case_no: c.court_case_no || '',
  });
}

// 사건에 딸린 서류/보정 일정을 구글 캘린더용 이벤트 형태로 변환 (하루종일 이벤트)
function caseTaskToGoogleEvent(task) {
  const c = db.prepare('SELECT client_name, court, court_case_no FROM cases WHERE id = ?').get(task.case_id) || {};
  const titleSuffix = task.status === '완료' ? '' : '예정';
  return {
    title: `${c.client_name || ''} ${task.task_type}${titleSuffix}`.trim(),
    description: [
      `사건: ${c.client_name || ''}`,
      c.court || c.court_case_no ? `관할: ${[c.court, c.court_case_no].filter(Boolean).join(' ')}` : null,
      `업무: ${task.task_type}`,
      task.received_date ? `송달/수령일: ${task.received_date}` : null,
      `상태: ${task.status}`,
      task.assignee_name ? `담당자: ${task.assignee_name}` : null,
      task.memo || null,
    ].filter(Boolean).join('\n'),
    location: '',
    all_day: 1,
    start_at: `${task.due_date}T00:00:00+09:00`,
    end_at: `${task.due_date}T00:00:00+09:00`,
    assignee_name: task.assignee_name,
    category: '법원',
  };
}

app.get('/api/case-tasks', requireLogin, async (req, res) => {
  const { status, caseId } = req.query;

  // 구글시트가 [일정_보정관리]의 원본으로 연동되어 있으면 시트를 실시간으로 읽어 보여준다
  // (직원이 시트에 입력한 내용이 그대로 반영됨). 연동 안 되어 있거나 읽기 실패 시 SQLite로 폴백.
  try {
    const sheetTasks = await readTasksFromSheetIfConnected();
    if (sheetTasks) {
      let rows = sheetTasks;
      if (status) rows = rows.filter((r) => r.status === status);
      if (caseId) rows = rows.filter((r) => String(r.case_id) === String(caseId));
      rows.sort((a, b) => a.due_date.localeCompare(b.due_date));
      return res.json(rows);
    }
  } catch (err) {
    console.error('구글시트 일정 읽기 실패, SQLite로 대체합니다:', err.message);
  }

  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (caseId) { conditions.push('case_id = ?'); params.push(caseId); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // case_id/due_date/status 에 인덱스가 있어 데이터가 수천 건으로 늘어나도
  // 필터가 걸린 조회는 빠르게 동작합니다 (전체 스캔 대신 인덱스 탐색).
  const rows = db.prepare(`SELECT * FROM case_tasks ${where} ORDER BY due_date ASC`).all(...params);
  res.json(rows.map(caseTaskWithCase));
});

app.post('/api/case-tasks', requireLogin, async (req, res) => {
  const { case_id, task_type, due_date, received_date, assignee_name, memo, status } = req.body || {};
  if (!case_id || !task_type || !due_date) return res.status(400).json({ error: '사건, 업무구분, 마감예정일은 필수입니다.' });

  const caseRow = db.prepare('SELECT * FROM cases WHERE id = ?').get(case_id);
  if (!caseRow) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  const safeStatus = CASE_TASK_STATUSES.includes(status) ? status : '예정';
  const info = db
    .prepare(`INSERT INTO case_tasks (case_id, task_type, received_date, due_date, status, assignee_name, memo, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(case_id, task_type, received_date || '', due_date, safeStatus, assignee_name || caseRow.assignee_name || '', memo || '', req.user.id);

  const task = db.prepare('SELECT * FROM case_tasks WHERE id = ?').get(info.lastInsertRowid);

  try {
    const googleEventId = await googleCreateEvent(caseTaskToGoogleEvent(task));
    if (googleEventId) {
      db.prepare('UPDATE case_tasks SET google_event_id = ? WHERE id = ?').run(googleEventId, task.id);
      task.google_event_id = googleEventId;
    }
  } catch (err) { console.error('구글 캘린더 등록 실패:', err.message); }

  res.status(201).json(caseTaskWithCase(task));
});

app.patch('/api/case-tasks/:id', requireLogin, async (req, res) => {
  if (String(req.params.id).startsWith('sheet-')) {
    return res.status(400).json({ error: '이 일정은 구글시트에서 관리됩니다. 시트에서 직접 상태를 변경해주세요.', code: 'SHEET_MANAGED' });
  }

  const task = db.prepare('SELECT * FROM case_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: '일정을 찾을 수 없습니다.' });

  const { task_type, due_date, received_date, status, assignee_name, memo } = req.body || {};
  const updated = {
    task_type: task_type ?? task.task_type,
    received_date: received_date ?? task.received_date,
    due_date: due_date ?? task.due_date,
    status: CASE_TASK_STATUSES.includes(status) ? status : task.status,
    assignee_name: assignee_name ?? task.assignee_name,
    memo: memo ?? task.memo,
  };

  db.prepare(`UPDATE case_tasks SET task_type=?, received_date=?, due_date=?, status=?, assignee_name=?, memo=?, updated_at=datetime('now') WHERE id = ?`)
    .run(updated.task_type, updated.received_date, updated.due_date, updated.status, updated.assignee_name, updated.memo, task.id);

  const fresh = db.prepare('SELECT * FROM case_tasks WHERE id = ?').get(task.id);

  try {
    if (fresh.google_event_id) {
      await googleUpdateEvent(fresh.google_event_id, caseTaskToGoogleEvent(fresh));
    } else {
      const googleEventId = await googleCreateEvent(caseTaskToGoogleEvent(fresh));
      if (googleEventId) {
        db.prepare('UPDATE case_tasks SET google_event_id = ? WHERE id = ?').run(googleEventId, fresh.id);
        fresh.google_event_id = googleEventId;
      }
    }
  } catch (err) { console.error('구글 캘린더 수정 실패:', err.message); }

  res.json(caseTaskWithCase(fresh));
});

app.delete('/api/case-tasks/:id', requireLogin, async (req, res) => {
  if (String(req.params.id).startsWith('sheet-')) {
    return res.status(400).json({ error: '이 일정은 구글시트에서 관리됩니다. 시트에서 직접 행을 삭제해주세요.', code: 'SHEET_MANAGED' });
  }

  const task = db.prepare('SELECT * FROM case_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: '일정을 찾을 수 없습니다.' });

  db.prepare('DELETE FROM case_tasks WHERE id = ?').run(task.id);

  try {
    if (task.google_event_id) await googleDeleteEvent(task.google_event_id);
  } catch (err) { console.error('구글 캘린더 삭제 실패:', err.message); }

  res.json({ ok: true });
});

/* ---- /api/sheets (사건목록 내보내기 + 일정_보정관리 구글시트 연동 상태) ---- */

app.get('/api/sheets/status', requireLogin, (req, res) => {
  const row = getStoredGoogleAuth();
  const spreadsheetId = row && row.sheets_spreadsheet_id;
  res.json({
    exported: !!spreadsheetId,
    url: spreadsheetId ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` : null,
    lastSyncedAt: (row && row.sheets_last_synced_at) || null,
    tasksManagedInSheet: !!(row && row.tasks_source === 'sheet'),
  });
});

app.post('/api/sheets/export', requireAdmin, async (req, res) => {
  try {
    const result = await exportCasesToGoogleSheet();
    res.json(result);
  } catch (err) {
    const status = err.code === 'NOT_CONNECTED' || err.code === 'NEEDS_RECONSENT' ? 400 : 500;
    res.status(status).json({ error: err.message, code: err.code || null });
  }
});

/* ---- /api/google ---- */

app.get('/api/google/status', requireLogin, (req, res) => {
  const row = getStoredGoogleAuth();
  res.json({ connected: isGoogleConnected(), calendarSummary: row ? row.calendar_summary : null, connectedAt: row ? row.connected_at : null });
});

app.get('/api/google/auth-url', requireAdmin, (req, res) => {
  try { res.json({ url: getGoogleAuthUrl() }); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('인증 코드가 없습니다.');
  if (!req.session || !req.session.userId) return res.status(401).send('관리자로 로그인한 상태에서 연동을 진행해주세요.');
  try {
    await handleGoogleOAuthCallback(code, req.session.userId);
    const employees = db.prepare("SELECT email FROM employees WHERE email IS NOT NULL AND email != ''").all();
    for (const e of employees) {
      try { await googleShareCalendar(e.email); } catch (err) { console.error('공유 실패:', e.email, err.message); }
    }
    res.redirect('/app.html?google=connected');
  } catch (err) {
    console.error(err);
    res.status(500).send('구글 캘린더 연동 중 오류가 발생했습니다: ' + err.message);
  }
});

app.post('/api/google/disconnect', requireAdmin, (req, res) => { disconnectGoogle(); res.json({ ok: true }); });

/* ---- 정적 페이지 ---- */

app.use('/icons', express.static(path.join(__dirname, 'icons'), { maxAge: '7d' }));

app.get('/manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/app.html', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'app.html'));
});

app.get('/cases.html', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'cases.html'));
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`); });
