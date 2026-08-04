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

-- 의뢰인별 인감도장/공동인증서 USB 수령 여부 추적. 의뢰인 명단 자체는 외부 구글시트가
-- 원본(읽기 전용)이라 여기 쓸 수 없으므로, 이 앱만의 추가 정보를 의뢰인명(+사건번호)으로
-- 매칭해서 별도 테이블에 보관한다.
CREATE TABLE IF NOT EXISTS client_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_name_key TEXT NOT NULL,
  court_case_no_key TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL,
  court_case_no TEXT,
  seal_received INTEGER NOT NULL DEFAULT 0,
  seal_received_date TEXT,
  cert_usb_received INTEGER NOT NULL DEFAULT 0,
  cert_usb_received_date TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_documents_key ON client_documents(client_name_key, court_case_no_key);
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
// 기존에 이미 만들어져 있는 외부 "의뢰인 명단" 구글시트를 사건목록 소스로 연결할 때 쓰는 컬럼
// (자체 생성한 sheets_spreadsheet_id와 같은 스프레드시트를 가리키게 되며, 그 안의 어느 탭이
// 의뢰인 명단인지만 이 컬럼에 별도로 기억해둔다).
try {
  db.exec("ALTER TABLE google_auth ADD COLUMN clients_sheet_tab TEXT");
} catch (err) {
  if (!String(err.message).includes('duplicate column')) throw err;
}

// 기존 DB에 category 컬럼이 없는 경우를 위한 마이그레이션 (이미 있으면 조용히 무시)
try {
  db.exec("ALTER TABLE schedules ADD COLUMN category TEXT NOT NULL DEFAULT '업무'");
} catch (err) {
  if (!String(err.message).includes('duplicate column')) throw err;
}

// 사건상세 페이지용 컬럼: 사건유형(개인회생/개인파산 등), 접수일, 담당변호사, 현재단계
for (const col of ['case_type TEXT', 'intake_date TEXT', 'assigned_lawyer TEXT', 'current_stage TEXT']) {
  try {
    db.exec(`ALTER TABLE cases ADD COLUMN ${col}`);
  } catch (err) {
    if (!String(err.message).includes('duplicate column')) throw err;
  }
}

// 수임료: 사건당 총액 1건 + 회차별 분할납부 내역
db.exec(`
CREATE TABLE IF NOT EXISTS case_fees (
  case_id INTEGER PRIMARY KEY,
  total_amount INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (case_id) REFERENCES cases(id)
);

CREATE TABLE IF NOT EXISTS case_fee_installments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 1,
  amount INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT '예정',
  paid_date TEXT,
  memo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (case_id) REFERENCES cases(id)
);
CREATE INDEX IF NOT EXISTS idx_case_fee_installments_case_id ON case_fee_installments(case_id);
`);

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
  'https://www.googleapis.com/auth/userinfo.email',
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
// 사건번호가 일치하는 쪽을 우선하고, 그래도 못 정하면 목록에서 가장 나중 순서(=최근)인 쪽을 사용.
// 비교용 정렬 키는 `_sortKey`(숫자)로 통일해서, SQLite 사건(id)이든 외부 시트 의뢰인(행 번호)이든
// 같은 로직으로 동점 처리할 수 있게 한다.
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
  return candidates.reduce((latest, c) => (c._sortKey > latest._sortKey ? c : latest), candidates[0]);
}

// 진홍 님이 이미 만들어둔 외부 "의뢰인 명단" 구글시트(예: [법진 사건관리] 스프레드시트의 특정 탭)를
// 읽어온다. 이 탭은 보통 IMPORTRANGE 등으로 채워진 읽기 전용 원본이라 앱에서 절대 쓰지 않는다.
// clients_sheet_tab이 설정되어 있지 않으면 null을 반환해서 호출 측이 SQLite cases로 폴백하게 한다.
async function readClientsFromExternalSheet() {
  const authRow = getStoredGoogleAuth();
  if (!authRow || !authRow.sheets_spreadsheet_id || !authRow.clients_sheet_tab) return null;

  const client = await getSheetsAuthorizedClient();
  if (!client) return null;

  const sheets = google.sheets({ version: 'v4', auth: client });
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: authRow.sheets_spreadsheet_id,
    range: `${authRow.clients_sheet_tab}!A2:E100000`,
  });
  const rows = resp.data.values || [];

  const clients = [];
  rows.forEach((row, i) => {
    // A=순번, B=이름, C=전화번호, D=법원, E=사건번호
    const [, name, phone, court, courtCaseNo] = row;
    if (!name) return;
    clients.push({
      id: `client-${i}`,
      _sortKey: i,
      source: 'external-client',
      client_name: name,
      phone: phone || '',
      court: court || '',
      court_case_no: courtCaseNo || '',
      assignee_name: '',
    });
  });
  return clients;
}

// 사건 매칭에 쓸 후보 목록을 가져온다: 외부 의뢰인 명단이 연결돼 있으면 그걸 우선 쓰고,
// 아니면 앱 자체 SQLite cases 테이블로 폴백한다 (기존 동작과 동일하게 유지).
async function getMatchCandidates() {
  const external = await readClientsFromExternalSheet();
  if (external) return external;
  return db.prepare('SELECT * FROM cases').all().map((c) => Object.assign({ _sortKey: c.id }, c));
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
  const cases = await getMatchCandidates();

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

// 일정은 시/분/초 없이 날짜 단위로만 관리한다 (하루 종일 이벤트로 고정).
// yyyy-mm-dd 앞 10자리만 취해서 자정(+09:00) 기준으로 다시 조립 - 어떤 형식으로 들어와도 항상 이 규칙을 강제한다.
function toAllDayDateTime(dateStr) {
  const datePart = String(dateStr || '').slice(0, 10);
  return `${datePart}T00:00:00+09:00`;
}

app.post('/api/schedules', requireLogin, async (req, res) => {
  const { title, description, location, start_at, end_at, assignee_name, category } = req.body || {};
  if (!title || !start_at || !end_at) return res.status(400).json({ error: '제목, 시작일, 종료일은 필수입니다.' });
  const safeCategory = SCHEDULE_CATEGORIES.includes(category) ? category : '업무';
  const normalizedStart = toAllDayDateTime(start_at);
  const normalizedEnd = toAllDayDateTime(end_at);

  const info = db
    .prepare(`INSERT INTO schedules (title, description, location, start_at, end_at, all_day, assignee_name, category, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(title, description || '', location || '', normalizedStart, normalizedEnd, 1, assignee_name || '', safeCategory, req.user.id);

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

  const { title, description, location, start_at, end_at, assignee_name, category } = req.body || {};
  const updated = {
    title: title ?? schedule.title,
    description: description ?? schedule.description,
    location: location ?? schedule.location,
    start_at: start_at ? toAllDayDateTime(start_at) : schedule.start_at,
    end_at: end_at ? toAllDayDateTime(end_at) : schedule.end_at,
    all_day: 1,
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

app.get('/api/cases/:id', requireLogin, (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });
  res.json(c);
});

app.post('/api/cases', requireLogin, (req, res) => {
  const { client_name, phone, court, court_case_no, assignee_name, memo, case_type, intake_date, assigned_lawyer, current_stage } = req.body || {};
  if (!client_name) return res.status(400).json({ error: '의뢰인명은 필수입니다.' });

  const info = db
    .prepare(`INSERT INTO cases (client_name, phone, court, court_case_no, assignee_name, memo, case_type, intake_date, assigned_lawyer, current_stage, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      client_name, phone || '', court || '', court_case_no || '', assignee_name || '', memo || '',
      case_type || '', intake_date || '', assigned_lawyer || '', current_stage || '', req.user.id
    );

  res.status(201).json(db.prepare('SELECT * FROM cases WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/cases/:id', requireLogin, (req, res) => {
  const existing = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  const { client_name, phone, court, court_case_no, assignee_name, memo, case_type, intake_date, assigned_lawyer, current_stage } = req.body || {};
  const updated = {
    client_name: client_name ?? existing.client_name,
    phone: phone ?? existing.phone,
    court: court ?? existing.court,
    court_case_no: court_case_no ?? existing.court_case_no,
    assignee_name: assignee_name ?? existing.assignee_name,
    memo: memo ?? existing.memo,
    case_type: case_type ?? existing.case_type,
    intake_date: intake_date ?? existing.intake_date,
    assigned_lawyer: assigned_lawyer ?? existing.assigned_lawyer,
    current_stage: current_stage ?? existing.current_stage,
  };
  db.prepare(`UPDATE cases SET client_name=?, phone=?, court=?, court_case_no=?, assignee_name=?, memo=?, case_type=?, intake_date=?, assigned_lawyer=?, current_stage=? WHERE id = ?`)
    .run(
      updated.client_name, updated.phone, updated.court, updated.court_case_no, updated.assignee_name, updated.memo,
      updated.case_type, updated.intake_date, updated.assigned_lawyer, updated.current_stage, existing.id
    );

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
  db.prepare('DELETE FROM case_fee_installments WHERE case_id = ?').run(existing.id);
  db.prepare('DELETE FROM case_fees WHERE case_id = ?').run(existing.id);
  db.prepare('DELETE FROM cases WHERE id = ?').run(existing.id);

  res.json({ ok: true });
});

/* ---- /api/cases/:id/fee (수임료 총액 + 회차별 분할납부) ---- */

const FEE_INSTALLMENT_STATUSES = ['예정', '완료'];

app.get('/api/cases/:id/fee', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT id FROM cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  const fee = db.prepare('SELECT * FROM case_fees WHERE case_id = ?').get(existing.id) || { case_id: existing.id, total_amount: 0, memo: '' };
  const installments = db.prepare('SELECT * FROM case_fee_installments WHERE case_id = ? ORDER BY seq ASC, id ASC').all(existing.id);
  res.json({ total_amount: fee.total_amount, memo: fee.memo || '', installments });
});

app.put('/api/cases/:id/fee', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT id FROM cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  const { total_amount, memo } = req.body || {};
  const amount = Number(total_amount) || 0;
  db.prepare(`
    INSERT INTO case_fees (case_id, total_amount, memo, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(case_id) DO UPDATE SET total_amount = excluded.total_amount, memo = excluded.memo, updated_at = datetime('now')
  `).run(existing.id, amount, memo || '');

  res.json({ total_amount: amount, memo: memo || '' });
});

app.post('/api/cases/:id/fee-installments', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT id FROM cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  const { seq, amount, due_date, status, paid_date, memo } = req.body || {};
  const safeStatus = FEE_INSTALLMENT_STATUSES.includes(status) ? status : '예정';

  const info = db.prepare(`
    INSERT INTO case_fee_installments (case_id, seq, amount, due_date, status, paid_date, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(existing.id, Number(seq) || 1, Number(amount) || 0, due_date || '', safeStatus, safeStatus === '완료' ? (paid_date || '') : '', memo || '');

  res.status(201).json(db.prepare('SELECT * FROM case_fee_installments WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/fee-installments/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM case_fee_installments WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '납부 회차를 찾을 수 없습니다.' });

  const { seq, amount, due_date, status, paid_date, memo } = req.body || {};
  const safeStatus = status !== undefined ? (FEE_INSTALLMENT_STATUSES.includes(status) ? status : existing.status) : existing.status;
  const updated = {
    seq: seq !== undefined ? (Number(seq) || existing.seq) : existing.seq,
    amount: amount !== undefined ? (Number(amount) || 0) : existing.amount,
    due_date: due_date ?? existing.due_date,
    status: safeStatus,
    paid_date: safeStatus === '완료' ? (paid_date ?? existing.paid_date ?? '') : '',
    memo: memo ?? existing.memo,
  };
  db.prepare(`UPDATE case_fee_installments SET seq=?, amount=?, due_date=?, status=?, paid_date=?, memo=?, updated_at=datetime('now') WHERE id = ?`)
    .run(updated.seq, updated.amount, updated.due_date, updated.status, updated.paid_date, updated.memo, existing.id);

  res.json(db.prepare('SELECT * FROM case_fee_installments WHERE id = ?').get(existing.id));
});

app.delete('/api/fee-installments/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT id FROM case_fee_installments WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '납부 회차를 찾을 수 없습니다.' });
  db.prepare('DELETE FROM case_fee_installments WHERE id = ?').run(existing.id);
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
    clientsConnected: !!(row && row.clients_sheet_tab),
    clientsTab: (row && row.clients_sheet_tab) || null,
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

/* ---- /api/clients (기존에 만들어둔 외부 "의뢰인 명단" 구글시트 연동) ---- */

// 관리자가 이미 갖고 있는 스프레드시트(예: [법진 사건관리])의 의뢰인 명단 탭을 연결한다.
// 1) 그 탭이 실제로 읽히는지 확인하고, 2) 같은 스프레드시트 안에 새 일정을 append할
// [일정_보정관리] 탭이 없으면 헤더와 함께 새로 만든 뒤, 3) 연동 정보를 저장한다.
// 의뢰인 명단 탭(예: 시트1)은 절대 건드리지 않는다 (읽기 전용, 보통 IMPORTRANGE로 채워져 있음).
app.post('/api/admin/clients-sheet', requireAdmin, async (req, res) => {
  const { url, tab } = req.body || {};
  const m = String(url || '').match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return res.status(400).json({ error: '구글시트 주소가 올바르지 않습니다. 브라우저 주소창의 전체 링크를 붙여넣어주세요.' });
  const spreadsheetId = m[1];
  const tabName = (tab || '시트1').trim();

  try {
    const client = await getSheetsAuthorizedClient();
    if (!client) {
      const err = new Error('구글 계정이 연동되어 있지 않습니다. 먼저 구글 캘린더 연동을 진행해주세요.');
      err.code = 'NOT_CONNECTED';
      throw err;
    }
    const sheets = google.sheets({ version: 'v4', auth: client });

    // 1) 의뢰인 명단 탭이 실제로 읽히는지 확인
    const clientsResp = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `${tabName}!A2:E100000`,
    });
    const clientCount = (clientsResp.data.values || []).filter((r) => r[1]).length;
    if (!clientCount) {
      return res.status(400).json({ error: `"${tabName}" 탭에서 의뢰인 이름(B열)을 하나도 찾지 못했습니다. 탭 이름이나 열 구성을 확인해주세요.` });
    }

    // 2) 일정_보정관리 탭이 없으면 새로 생성 (기존 탭은 절대 건드리지 않음)
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const hasTasksTab = meta.data.sheets.some((s) => s.properties.title === SHEETS_TITLE_TASKS);
    if (!hasTasksTab) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: SHEETS_TITLE_TASKS } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId, range: `${SHEETS_TITLE_TASKS}!A1`, valueInputOption: 'RAW', requestBody: { values: [TASKS_SHEET_HEADER] },
      });
    }

    // 3) 연동 정보 저장
    db.prepare("UPDATE google_auth SET sheets_spreadsheet_id = ?, clients_sheet_tab = ?, tasks_source = 'sheet' WHERE id = 1")
      .run(spreadsheetId, tabName);

    res.json({ ok: true, clientCount, tab: tabName, tasksTabCreated: !hasTasksTab });
  } catch (err) {
    if (err.code === 'NOT_CONNECTED') return res.status(400).json({ error: err.message, code: err.code });
    // 기존에 연동된 계정이 (구)캘린더 권한만 갖고 있어 시트 권한 자체가 없는 경우 (공유 문제와는 다름)
    if (/insufficient.*scope|insufficient authentication scopes/i.test(err.message || '')) {
      return res.status(403).json({
        error: '구글 계정에 스프레드시트 권한이 없습니다. "구글 캘린더 연동"에서 "다시 연결하기"를 눌러 재연동해주세요 (시트 권한이 추가되었습니다).',
        code: 'NEEDS_RECONSENT',
      });
    }
    // 구글 클라우드 프로젝트에서 Sheets API 자체가 비활성화된 경우 (공유 문제와 무관)
    if (/has not been used in project|it is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(err.message || '')) {
      return res.status(403).json({
        error: '구글 클라우드 프로젝트에서 "Google Sheets API"가 비활성화되어 있습니다. 개발자에게 Google Cloud Console에서 Sheets API를 활성화해달라고 요청해주세요. (상세: ' + err.message + ')',
        code: 'API_DISABLED',
      });
    }
    if (err.code === 403 || /permission/i.test(err.message || '')) {
      return res.status(403).json({
        error: '이 스프레드시트에 대한 접근 권한이 없습니다. 구글 캘린더 연동에 사용 중인 계정과 이 시트를 공유(편집자 권한)해주세요. (상세: ' + (err.message || '') + ')',
        code: 'NO_ACCESS',
      });
    }
    if (/Unable to parse range|not found/i.test(err.message || '')) {
      return res.status(400).json({ error: `"${tabName}" 이라는 이름의 탭을 찾을 수 없습니다. 탭 이름을 다시 확인해주세요.` });
    }
    console.error('의뢰인 시트 연결 실패:', err.message);
    res.status(500).json({ error: '연결 중 오류가 발생했습니다: ' + err.message });
  }
});

// 인감도장/공동인증서 USB 수령 여부는 앱 자체 SQLite에 보관 (원본 시트는 읽기 전용이라 쓸 수 없음).
function getClientDocs(clientName, courtCaseNo) {
  return db.prepare('SELECT * FROM client_documents WHERE client_name_key = ? AND court_case_no_key = ?')
    .get(normalizeMatchKey(clientName), normalizeMatchKey(courtCaseNo));
}

function attachClientDocs(c) {
  const docs = getClientDocs(c.client_name, c.court_case_no);
  return Object.assign({}, c, {
    seal_received: !!(docs && docs.seal_received),
    seal_received_date: (docs && docs.seal_received_date) || '',
    cert_usb_received: !!(docs && docs.cert_usb_received),
    cert_usb_received_date: (docs && docs.cert_usb_received_date) || '',
  });
}

// getClients() 역할: 자동완성/검색창에 쓸 의뢰인 목록을 돌려준다. 인감도장·USB 수령 여부도 같이 붙여서 준다.
app.get('/api/clients', requireLogin, async (req, res) => {
  try {
    const clients = await readClientsFromExternalSheet();
    // 화면에는 시트 역순(최근에 추가된 의뢰인이 위로 오도록)으로 보여준다.
    // _sortKey(원본 시트 행 순서)는 그대로 유지되므로 사건 매칭 로직에는 영향이 없다.
    res.json((clients || []).slice().reverse().map(attachClientDocs));
  } catch (err) {
    console.error('의뢰인 목록 읽기 실패:', err.message);
    res.status(500).json({ error: '의뢰인 목록을 불러오지 못했습니다: ' + err.message });
  }
});

// 인감도장/공동인증서 USB 수령 여부를 저장한다 (의뢰인명+사건번호로 upsert).
app.post('/api/clients/documents', requireLogin, (req, res) => {
  const { client_name, court_case_no, seal_received, seal_received_date, cert_usb_received, cert_usb_received_date } = req.body || {};
  if (!client_name) return res.status(400).json({ error: '의뢰인명이 필요합니다.' });

  const nameKey = normalizeMatchKey(client_name);
  const caseNoKey = normalizeMatchKey(court_case_no);
  const sealReceived = seal_received ? 1 : 0;
  const certReceived = cert_usb_received ? 1 : 0;

  db.prepare(`
    INSERT INTO client_documents (client_name_key, court_case_no_key, client_name, court_case_no, seal_received, seal_received_date, cert_usb_received, cert_usb_received_date, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(client_name_key, court_case_no_key) DO UPDATE SET
      client_name = excluded.client_name,
      court_case_no = excluded.court_case_no,
      seal_received = excluded.seal_received,
      seal_received_date = excluded.seal_received_date,
      cert_usb_received = excluded.cert_usb_received,
      cert_usb_received_date = excluded.cert_usb_received_date,
      updated_at = datetime('now'),
      updated_by = excluded.updated_by
  `).run(
    nameKey, caseNoKey, client_name, court_case_no || '',
    sealReceived, sealReceived ? (seal_received_date || '') : '',
    certReceived, certReceived ? (cert_usb_received_date || '') : '',
    req.user.id
  );

  res.json({
    ok: true,
    seal_received: !!sealReceived,
    seal_received_date: sealReceived ? (seal_received_date || '') : '',
    cert_usb_received: !!certReceived,
    cert_usb_received_date: certReceived ? (cert_usb_received_date || '') : '',
  });
});

// 의뢰인 목록(외부 구글시트)에서 "사건상세 페이지 열기"를 눌렀을 때 쓴다.
// 같은 의뢰인의 사건(cases)이 이미 있으면 그 사건으로, 없으면 시트에 있는 정보
// (이름/연락처/법원/사건번호)로 새 사건을 자동 생성해서 사건상세 페이지로 보낸다.
// OSMU 원칙: 의뢰인 시트에 이미 입력된 정보를 사건관리 화면에서 다시 입력하지 않는다.
app.post('/api/clients/open-case', requireLogin, (req, res) => {
  const { client_name, phone, court, court_case_no } = req.body || {};
  if (!client_name) return res.status(400).json({ error: '의뢰인명이 필요합니다.' });

  const cases = db.prepare('SELECT * FROM cases').all().map((c) => Object.assign({ _sortKey: c.id }, c));
  const matched = matchCaseByNameAndCaseNo(cases, client_name, court_case_no);
  if (matched) return res.json({ id: matched.id, created: false });

  const info = db
    .prepare(`INSERT INTO cases (client_name, phone, court, court_case_no, assignee_name, memo, case_type, intake_date, assigned_lawyer, current_stage, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(client_name, phone || '', court || '', court_case_no || '', '', '', '', '', '', '', req.user.id);
  res.status(201).json({ id: info.lastInsertRowid, created: true });
});

// addSchedule() 역할: 선택한 의뢰인 정보 + 할 일 + 마감일을 [일정_보정관리] 탭 맨 아래에 추가한다.
app.post('/api/clients/schedule', requireLogin, async (req, res) => {
  const { client_name, court_case_no, task_type, due_date, received_date, assignee_name, memo } = req.body || {};
  if (!client_name || !task_type || !due_date) {
    return res.status(400).json({ error: '의뢰인, 업무구분, 마감예정일은 필수입니다.' });
  }

  const authRow = getStoredGoogleAuth();
  if (!authRow || !authRow.sheets_spreadsheet_id || !authRow.clients_sheet_tab) {
    return res.status(400).json({ error: '의뢰인 시트가 아직 연동되어 있지 않습니다.', code: 'NOT_CONNECTED' });
  }

  try {
    const client = await getSheetsAuthorizedClient();
    if (!client) { const err = new Error('구글 계정이 연동되어 있지 않습니다.'); err.code = 'NOT_CONNECTED'; throw err; }
    const sheets = google.sheets({ version: 'v4', auth: client });

    const row = [
      client_name, task_type, received_date || '', due_date,
      '예정', assignee_name || (req.user && req.user.name) || '', court_case_no || '', memo || '',
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: authRow.sheets_spreadsheet_id,
      range: `${SHEETS_TITLE_TASKS}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('일정 등록(시트 append) 실패:', err.message);
    res.status(500).json({ error: '일정을 시트에 저장하지 못했습니다: ' + err.message, code: err.code || null });
  }
});

/* ---- /api/google ---- */

app.get('/api/google/status', requireLogin, (req, res) => {
  const row = getStoredGoogleAuth();
  res.json({ connected: isGoogleConnected(), calendarSummary: row ? row.calendar_summary : null, connectedAt: row ? row.connected_at : null });
});

// 현재 연동된 구글 계정이 어떤 이메일인지 확인 (의뢰인 시트 등을 공유할 때 어떤 계정에 공유해야 하는지 알려주기 위함)
app.get('/api/google/whoami', requireAdmin, async (req, res) => {
  if (!isGoogleConnected()) return res.status(400).json({ error: '구글 계정이 연동되어 있지 않습니다.' });
  try {
    const client = await getAuthorizedGoogleClient();
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const info = await oauth2.userinfo.get();
    res.json({ email: info.data.email || null, displayName: info.data.name || null });
  } catch (err) {
    console.error('구글 계정 조회 실패:', err.message);
    if (/insufficient|scope/i.test(err.message || '')) {
      return res.status(409).json({
        error: '이 기능을 사용하려면 구글 계정을 다시 연동해주세요 (팀 스케줄 화면 > 구글 캘린더 연동 해제 후 재연동).',
        code: 'NEEDS_RECONNECT',
      });
    }
    res.status(500).json({ error: '연동된 구글 계정 정보를 가져오지 못했습니다: ' + err.message });
  }
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

app.get('/clients.html', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'clients.html'));
});

app.get('/case-detail.html', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'case-detail.html'));
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`); });
