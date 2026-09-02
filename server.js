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
const multer = require('multer');
const XLSX = require('xlsx');
const crypto = require('crypto');
const webpush = require('web-push');

/* ------------------------------------------------------------------ */
/* 데이터베이스                                                        */
/* ------------------------------------------------------------------ */

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 사건(상담/의뢰인)별 첨부 파일 저장 위치. DATA_DIR과 마찬가지로 영구 디스크 아래에 둬서
// 배포/재시작에도 파일이 사라지지 않도록 한다 (문서는 자산이다 원칙).
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

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

-- 팀 일정 카카오톡 알림("나에게 보내기") 수신자. label마다 카카오 로그인 refresh_token을
-- 하나씩 보관한다 - 등록된 계정 수만큼 각자의 "나와의 채팅방"으로 발송할 수 있다.
CREATE TABLE IF NOT EXISTS kakao_recipients (
  label TEXT PRIMARY KEY,
  refresh_token TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  include_fee_calendar INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
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

-- case_notes(메모 누적 기록): 사건(cases)의 memo 칸은 "상담내용요약" 하나만 담는 단일 필드로 쓰고,
-- 계속 쌓이는 메모는 이 테이블에 별도로 남긴다. 법률사무소 실무 기록이라 정정이 필요해도 기존 행을
-- 고치지 않고 새 메모를 추가하는 방식으로만 쓴다 - 그래서 UPDATE/DELETE API를 만들지 않는다
-- (수정불가/append-only). 작성일시(created_at)·작성자(created_by)는 서버가 자동으로 채운다.
CREATE TABLE IF NOT EXISTS case_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (case_id) REFERENCES cases(id),
  FOREIGN KEY (created_by) REFERENCES employees(id)
);
CREATE INDEX IF NOT EXISTS idx_case_notes_case_id ON case_notes(case_id);

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
// 카카오 일정 알림 수신자 중 수임료 캘린더(case_fee_installments)도 함께 받을 사람을 표시하는 컬럼.
// kakao_recipients 테이블이 먼저 배포된 뒤에 추가된 컬럼이라 기존 행과의 호환을 위해 마이그레이션한다.
try {
  db.exec("ALTER TABLE kakao_recipients ADD COLUMN include_fee_calendar INTEGER NOT NULL DEFAULT 0");
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

// 관리자 전용 비공개 일정(예: 수임료 납부일정 자동 연동) 표시를 위한 컬럼.
// 1이면 관리자에게만 보이고, 직원 계정의 캘린더/검색에서는 항상 제외된다.
try {
  db.exec("ALTER TABLE schedules ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0");
} catch (err) {
  if (!String(err.message).includes('duplicate column')) throw err;
}

// 탭별 접근권한: 직원(role='employee') 계정이 볼 수 있는 탭을 콤마로 구분해 저장한다.
// (예: "fee" 하나만 저장하면 수임료 캘린더만 접근 가능한 직원이 된다.) NULL/빈 문자열이면
// "제한 없음"으로 취급한다 — 이 컬럼이 생기기 전부터 있던 기존 직원 계정들의 접근 범위가
// 이 기능 배포로 갑자기 좁아지는 일이 없도록 하기 위함이다(기존 기능을 깨뜨리지 않는다).
// 관리자(admin) 계정은 이 값과 무관하게 항상 모든 탭에 접근할 수 있다.
try {
  db.exec("ALTER TABLE employees ADD COLUMN allowed_tabs TEXT");
} catch (err) {
  if (!String(err.message).includes('duplicate column')) throw err;
}

// 사건상세 페이지용 컬럼: 사건유형(개인회생/개인파산 등), 접수일, 담당변호사, 현재단계
// status: 의뢰인 여정 전체 단계(상담중/접수전/사건진행중/개시결정후) — case_type별 세부 절차인
// current_stage와는 별개의 축이다. 상담관리 페이지에서 새 상담을 등록하면 status='상담중'으로
// 시작하고, 같은 레코드(같은 Client ID)의 status만 바뀌므로 계약 전후로 정보를 다시 입력하지 않는다.
// seal_received 등 서류 수령 여부도 사건(=Client) 레코드에 직접 붙여서, 상담 단계에서 이미 받은
// 인감도장/USB 정보가 나중에 의뢰인으로 전환돼도 그대로 이어지도록 한다.
for (const col of [
  'case_type TEXT', 'intake_date TEXT', 'assigned_lawyer TEXT', 'current_stage TEXT', 'status TEXT',
  'seal_received INTEGER NOT NULL DEFAULT 0', 'seal_received_date TEXT',
  'cert_usb_received INTEGER NOT NULL DEFAULT 0', 'cert_usb_received_date TEXT',
  'updated_at TEXT', 'retainer_date TEXT', 'region TEXT', 'client_rank INTEGER',
  'consult_date TEXT', 'consult_report_json TEXT',
  'client_grade TEXT', 'client_grade_reason TEXT',
  'alimtalk_count INTEGER NOT NULL DEFAULT 0', 'alimtalk_last_sent TEXT',
  'birth_date TEXT',
]) {
  try {
    db.exec(`ALTER TABLE cases ADD COLUMN ${col}`);
  } catch (err) {
    if (!String(err.message).includes('duplicate column')) throw err;
  }
}
// updated_at이 없는 기존 사건은 등록일로 백필 (의뢰인 목록을 "최근 변경순"으로 보여주기 위해 필요).
db.exec("UPDATE cases SET updated_at = created_at WHERE updated_at IS NULL");

// 고객등급(client_grade): 상담관리 페이지에서 쓰는 "영업 파이프라인" 축. status(사건 진행 단계)와는
// 완전히 별개의 개념이라 둘이 동시에 존재할 수 있다 (예: 수임완료 + 접수전 → 이후 수임완료 + 사건진행중).
// 직원마다 판단 기준이 달라 데이터가 어긋나는 일이 없도록, 각 등급의 정의를 서버/프론트 양쪽에 고정해둔다.
//   0.수임완료 — 계약 완료
//   1.진행임박 — 진행 의사가 명확함. 방문/계약/입금 등 구체적 행동이 예정되어 있음 (좁게 적용)
//   2.진행유력 — 가능성 높음. 추가 상담/검토 중
//   3.진행유보 — 당장 진행하지 않음. 추후 가능성 있음 ("생각해보고 연락드릴게요" 등은 여기)
//   4.부재중 — 상담 자체가 아직 제대로 이루어지지 않음
//   5.드롭 — 더 이상 추적하지 않음 (드롭 사유 필수)
//   (미지정/빈 값) — 아직 등급 판단 전
// 등급 수정(및 드롭 사유 설정)은 관리자(admin) 계정만 가능하다 — 아래 PATCH 핸들러에서 강제한다.
const CLIENT_GRADES = ['0', '1', '2', '3', '4', '5'];
// 드롭(5) 처리 시 선택하는 사유. 추후 상담→계약 전환율 분석(상담 100건 중 왜 20건만 계약됐는지 등)에 쓰인다.
const DROP_REASONS = ['연락두절', '비용', '타사선임', '진행의사없음', '자격미달', '시기미정', '기타'];

// birth_date(생년월일, yyyy-mm-dd): 의뢰인용 진행현황 페이지(/client-status.html →
// POST /api/portal/status)에서 "이름+생년월일"로 본인 사건만 조회하게 해주는 본인확인용 값.
// 기존 사건에는 값이 비어있으므로, 사건상세 화면에서 관리자가 직접 입력해야 그 의뢰인부터
// 조회 기능을 쓸 수 있다 (일괄 소급입력은 하지 않음 — 잘못된 사람 손에 넘어가면 안 되는 값이라
// 반드시 담당자가 사건별로 직접 확인하며 입력하도록 한다).

// consult_date(상담일) vs intake_date(접수일, 법원 접수 시점)는 서로 다른 개념인데, 예전엔
// consult-report.html이 상담일을 intake_date 칸에 그대로 써넣어서 나중에 접수일을 입력/수정하면
// 원래 상담일이 지워지는 문제가 있었다. consult_date 칸을 새로 분리하면서, 기존 사건은 지금까지
// intake_date에 들어있던 값을 상담일의 최선 추정치로 백필한다(완전한 과거 복원은 불가능하지만
// 이 시점부터는 두 값이 다시 섞이지 않는다).
db.exec("UPDATE cases SET consult_date = intake_date WHERE consult_date IS NULL AND intake_date IS NOT NULL AND intake_date != ''");

// client_rank(의뢰인목록 고정 정렬키): retainer_date는 시트 표기가 제각각이라 정렬이 들쭉날쭉해
// "뒤죽박죽"으로 보이는 문제가 있었다. client_rank는 숫자가 클수록 목록 맨 위에 뜨는 고정 순번이며,
// 한 번 정해지면 다른 값이 바뀌어도(수정/완료처리 등) 흔들리지 않는다. 새 사건이 생성되면 이
// 트리거가 "현재 최댓값 + 1"을 자동으로 부여하므로, 어떤 화면(상담관리/사건관리/수임료 이식 등)에서
// 만들어지든 항상 맨 위에 새로 쌓인다 — 생성 경로를 개별적으로 다 고칠 필요가 없도록 트리거로 처리.
db.exec(`
CREATE TRIGGER IF NOT EXISTS trg_cases_client_rank_autofill
AFTER INSERT ON cases
WHEN NEW.client_rank IS NULL
BEGIN
  UPDATE cases SET client_rank = (SELECT COALESCE(MAX(client_rank), 0) + 1 FROM cases) WHERE id = NEW.id;
END;
`);

// retainer_date(수임일자): 접수일(intake_date, 법원 접수 시점)과는 다른 개념 — 의뢰인과 실제
// 수임계약을 맺은 날짜. "수임료 관리" 구글시트(FEE_MIGRATION_SPREADSHEET_ID) D열이 원본이며,
// /api/admin/retainer-date-migration-run으로 1회 이식한다. 의뢰인목록 정렬 기준으로 쓴다.

// region(거주지역): 상담결과리포트(consult-report.html)에서 "신규 상담"을 저장하면 자동으로
// 채워지는 필드. 관할법원 자동추천에 쓰인 값과 동일한 지역명을 그대로 저장해 재입력을 없앤다.

// 상담레포트 등 사건(=상담/의뢰인)에 첨부하는 문서 파일. 실제 파일은 DATA_DIR(영구 디스크) 아래에
// 저장하고, 이 테이블에는 메타데이터만 보관한다 (문서는 자산이므로 삭제를 전제로 하지 않는다).
db.exec(`
CREATE TABLE IF NOT EXISTS case_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  category TEXT,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER,
  uploaded_by INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (case_id) REFERENCES cases(id),
  FOREIGN KEY (uploaded_by) REFERENCES employees(id)
);
CREATE INDEX IF NOT EXISTS idx_case_files_case_id ON case_files(case_id);
`);

// 의뢰인용 진행현황(client-status.html) 타임라인의 원본 기록. current_stage(사건상세의 단일 "현재단계"
// select, 6단계)와는 완전히 별개의 새 데이터다 — 기존 값을 건드리면 이미 저장된 사건들의 단계가
// 조용히 지워질 위험이 있어(옵션 목록이 바뀌면 select가 빈 값이 되고, 그대로 저장하면 덮어써진다),
// 아예 새 테이블로 분리했다. 한 사건이 같은 단계를 여러 번 기록할 수 있다 — 보정권고송달/제출처럼
// 절차상 여러 차례 반복되는 단계는 그때마다 새 행을 추가하면 그게 곧 "n회차"가 된다.
db.exec(`
CREATE TABLE IF NOT EXISTS case_stage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  event_date TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (case_id) REFERENCES cases(id),
  FOREIGN KEY (created_by) REFERENCES employees(id)
);
CREATE INDEX IF NOT EXISTS idx_case_stage_events_case_id ON case_stage_events(case_id);
`);

// 사건유형별 의뢰인용 타임라인 단계 목록(순서 = 진행 순서). 현재는 개인회생만 절차를 정확히 알고
// 있어 우선 반영했다 — 다른 사건유형은 이 목록에 없으므로 client-status.html에서 기존 방식대로
// "진행 단계(상태 배지) + 다음 일정"으로만 보여준다(4-5: 기존 기능을 깨지 않는다).
const CASE_STAGE_TIMELINE = {
  '개인회생': ['서류발급중', '신청서작성중', '접수완료', '금지명령신청', '보정권고송달', '보정권고제출', '개시결정', '채권자집회', '인가결정'],
};

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

// 이 납부 회차가 팀 스케줄에 자동 생성한 비공개 일정을 가리키는 컬럼(OSMU: 같은 데이터를
// 두 번 입력하지 않고, 사건 상세페이지 ↔ 팀 스케줄이 항상 하나의 데이터를 참조하게 한다).
try {
  db.exec('ALTER TABLE case_fee_installments ADD COLUMN schedule_id INTEGER');
} catch (err) {
  if (!String(err.message).includes('duplicate column')) throw err;
}

// 팀 스케줄에 자동 동기화되던 수임료 일정을 완전히 제거한다 (2026-08 결정: 수임료는
// 전용 캘린더(fee-calendar.html)에서만 관리하고, 팀 스케줄에는 더 이상 노출하지 않는다).
// is_private=1 은 수임료 동기화 전용으로만 쓰이던 컬럼이라 이 조건만으로 안전하게 지울 수 있다.
// 매 서버 시작마다 실행해도 무해하다(idempotent) — 더 이상 생성되지 않으므로 이후엔 0건이 지워진다.
db.exec('DELETE FROM schedules WHERE is_private = 1');
db.exec('UPDATE case_fee_installments SET schedule_id = NULL WHERE schedule_id IS NOT NULL');

// 결제방식(현금/계좌이체/신용카드)과 입금자명(의뢰인 본인이 아닌 다른 사람 이름으로 입금된 경우
// 대비) — 각 납부 회차마다 따로 기록한다. 예전에는 memo 텍스트에 "결제방식: OOO"로만 적어뒀는데,
// 통장매칭·통계 등에서 구조적으로 활용할 수 없어 전용 컬럼으로 분리한다.
for (const col of ['payment_method TEXT', 'payer_name TEXT']) {
  try {
    db.exec(`ALTER TABLE case_fee_installments ADD COLUMN ${col}`);
  } catch (err) {
    if (!String(err.message).includes('duplicate column')) throw err;
  }
}

// (일회성, 매 시작마다 실행해도 안전 — 한 번 옮겨진 행은 더 이상 조건에 안 걸림)
// 기존 memo의 "결제방식: OOO [/ 통장매칭 자동확인(입금자명)]" 텍스트를 새 컬럼으로 옮기고
// memo에서는 그 부분만 제거한다 — 정보를 잃는 게 아니라 검색/통계가 가능한 구조로 옮기는 것.
const FEE_PAYMENT_METHOD_ALIASES = {
  '현금': '현금', '현금완납': '현금', '현금납부': '현금',
  '계좌이체': '계좌이체', '계좌': '계좌이체', '이체': '계좌이체', '무통장입금': '계좌이체', '통장입금': '계좌이체',
  '카드': '신용카드', '카드결제': '신용카드', '신용카드': '신용카드', '카드납부': '신용카드',
};
{
  const legacyRows = db.prepare(`
    SELECT id, memo FROM case_fee_installments
    WHERE (payment_method IS NULL OR payment_method = '') AND memo LIKE '%결제방식:%'
  `).all();
  legacyRows.forEach((row) => {
    const memo = String(row.memo || '');
    const methodMatch = memo.match(/결제방식:\s*([^\s/]+)/);
    if (!methodMatch) return;
    const method = FEE_PAYMENT_METHOD_ALIASES[methodMatch[1].trim()];
    if (!method) return; // 매핑 안 되는 표현은 memo를 그대로 두고 건드리지 않는다 (데이터 손실 방지)

    const payerMatch = memo.match(/통장매칭\s*자동확인\((.*?)\)/);
    const payerName = payerMatch ? payerMatch[1].trim() : '';

    let cleanedMemo = memo
      .replace(/결제방식:\s*[^\s/]+/, '')
      .replace(/통장매칭\s*자동확인\(.*?\)/, '통장매칭 자동확인')
      .replace(/^\s*\/\s*/, '').replace(/\s*\/\s*$/, '').replace(/\s*\/\s*\/\s*/, ' / ')
      .trim();

    db.prepare('UPDATE case_fee_installments SET payment_method = ?, payer_name = ?, memo = ? WHERE id = ?')
      .run(method, payerName, cleanedMemo, row.id);
  });
}

// match_source(완료 처리 방식): 통장매칭 자동확인으로 완료됐는지, 사람이 직접 완료 체크했는지
// 구분해서 기록한다. 값은 '자동'(통장매칭) / '수동'(사람이 직접 완료 체크) 두 가지.
try {
  db.exec("ALTER TABLE case_fee_installments ADD COLUMN match_source TEXT");
} catch (err) {
  if (!String(err.message).includes('duplicate column')) throw err;
}
// (일회성, 매 시작마다 실행해도 안전) 이미 완료 처리돼 있는데 아직 match_source가 없는 기존
// 행은, memo에 남아있는 "통장매칭 자동확인" 흔적으로 판단해서 자동/수동을 나눠 채워 넣는다.
db.exec(`
  UPDATE case_fee_installments SET match_source = '자동'
  WHERE status = '완료' AND (match_source IS NULL OR match_source = '') AND memo LIKE '%통장매칭 자동확인%'
`);
db.exec(`
  UPDATE case_fee_installments SET match_source = '수동'
  WHERE status = '완료' AND (match_source IS NULL OR match_source = '')
`);

// 통장 거래내역 중에는 애초에 "사건(case)"이 없는 사람의 입금(예: 상담만 받고 의뢰하지 않은
// 사람의 상담료)이 섞여 있다 — 이런 건 붙여둘 회차 자체가 없어서 항상 미매칭으로 뜨고, 통장
// 내역을 다시 업로드할 때마다(기간이 겹치면) 같은 건이 계속 노이즈로 반복 노출된다. 그렇다고
// 그 거래내역 자체를 지우는 건 원칙 11(데이터는 절대 잃지 않는다)에 어긋나므로, "이 입금은
// 사건과 무관하다고 이미 확인했다"는 표시만 별도 테이블에 남겨서 다음 재분석부터 걸러낸다.
db.exec(`
CREATE TABLE IF NOT EXISTS fee_calendar_ignored_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deposit_date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '상담료 등 (사건과 무관)',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fee_ignored_deposits_key ON fee_calendar_ignored_deposits(deposit_date, amount, memo);
`);

// 앱 전역 기본값 설정(담당직원/담당변호사 기본값 등) — 단일 행(id=1)만 사용
db.exec(`
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_assignee_name TEXT NOT NULL DEFAULT '',
  default_lawyer_name TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
db.prepare(
  `INSERT OR IGNORE INTO app_settings (id, default_assignee_name, default_lawyer_name) VALUES (1, ?, ?)`
).run('진홍', '정해원 변호사');

function getAppSettings() {
  return db.prepare('SELECT * FROM app_settings WHERE id = 1').get();
}

// 웹 푸시 알림 구독 정보. 카카오톡("나에게 보내기")과 달리 브라우저/기기별로 구독이 따로 생기므로
// (같은 직원이 폰+PC를 다 켜두면 둘 다 별도 구독), employee_id 하나에 여러 행이 붙을 수 있다.
// endpoint는 브라우저가 구독마다 발급하는 고유 주소라 UNIQUE로 중복 구독을 막는다.
db.exec(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_employee ON push_subscriptions(employee_id);
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

// 탭별 접근권한이 걸리는 대상 탭 목록. "팀 스케줄"과 "설정"은 여기 포함하지 않는다 —
// 팀 스케줄은 로그인 직후 랜딩 페이지라 누구나 항상 봐야 하고, 설정(직원 관리·구글 연동 등)은
// 성격상 언제나 관리자 전용으로 남아야 하기 때문이다.
const RESTRICTABLE_TABS = ['cases', 'consultations', 'clients', 'fee'];

function hasTabAccess(user, tab) {
  if (user.role === 'admin') return true;
  // null/undefined("미설정") = 기존과 동일하게 전체 허용(하위호환). 반면 ''(빈 문자열)은
  // 관리자가 탭을 전부 명시적으로 해제한 상태이므로 falsy라고 곧장 true를 돌려주면 안 된다 —
  // 그러면 "모든 탭을 차단당한 직원"이 오히려 전체 접근 권한을 갖는 보안 버그가 생긴다.
  if (user.allowed_tabs === null || user.allowed_tabs === undefined) return true;
  return user.allowed_tabs.split(',').map((s) => s.trim()).filter(Boolean).includes(tab);
}

function requireTab(tab) {
  return function (req, res, next) {
    requireLogin(req, res, () => {
      if (!hasTabAccess(req.user, tab)) {
        return res.status(403).json({ error: '이 기능에 접근할 권한이 없습니다.' });
      }
      next();
    });
  };
}

/* ------------------------------------------------------------------ */
/* 사건 첨부파일 업로드 (상담레포트 등)                                    */
/* ------------------------------------------------------------------ */

const CASE_FILE_MAX_SIZE = 20 * 1024 * 1024; // 20MB
const CASE_FILE_ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx', '.hwp'];
// 미리보기(inline) 응답용 MIME 타입. PDF/이미지는 브라우저가 바로 렌더링하고, doc/docx/hwp는
// 브라우저에 뷰어가 없어 결국 다운로드로 처리되지만 Content-Type은 정확히 맞춰준다.
const CASE_FILE_MIME = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.hwp': 'application/x-hwp',
};

const caseFileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_DIR, `case-${req.params.id}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const stamp = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${stamp}${ext}`);
  },
});

const uploadCaseFile = multer({
  storage: caseFileStorage,
  limits: { fileSize: CASE_FILE_MAX_SIZE },
  fileFilter: (req, file, cb) => {
    // 브라우저는 파일명을 UTF-8로 보내는데, multer가 쓰는 busboy는 기본적으로 이를 latin1로
    // 해석해서 한글 파일명이 깨진다(예: "상담결과리포트.pdf" → 알아볼 수 없는 문자열). fileFilter가
    // filename 콜백보다 먼저 실행되므로, 여기서 한 번 되돌려두면 이후(파일명 저장, DB 기록)에서
    // 전부 올바른 한글로 쓰인다.
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(file.originalname).toLowerCase();
    if (!CASE_FILE_ALLOWED_EXT.includes(ext)) {
      return cb(new Error('허용되지 않는 파일 형식입니다 (PDF, 이미지, 문서 파일만 업로드할 수 있습니다).'));
    }
    cb(null, true);
  },
});

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

// 사건 매칭에 쓸 후보 목록: 앱 자체 SQLite cases 테이블 (2026-08부터 유일한 원본).
// (예전엔 외부 "의뢰인 명단" 구글시트를 우선 썼지만, 그 연동 기능 자체를 제거했다.)
async function getMatchCandidates() {
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

// [일정_보정관리] 탭을 원본으로 쓰던 것을 앱(SQLite case_tasks)으로 전환한다.
// 시트에 남아있는 모든 행을 case_tasks로 옮기고(사건이 없으면 새로 만듦), 이후로는
// tasks_source를 'app'으로 바꿔 GET /api/case-tasks가 SQLite만 보게 한다.
// 시트 자체는 지우지 않는다 (기록 보존 — "데이터는 절대 잃지 않는다").
async function migrateSheetTasksToApp(adminUserId) {
  const sheetTasks = await readTasksFromSheetIfConnected();
  if (!sheetTasks) {
    return { migrated: 0, createdCases: 0, alreadyApp: true };
  }

  const realCases = db.prepare('SELECT * FROM cases').all().map((c) => Object.assign({ _sortKey: c.id }, c));
  let migrated = 0;
  let createdCases = 0;

  for (const t of sheetTasks) {
    let matchedCase = matchCaseByNameAndCaseNo(realCases, t.client_name, t.court_case_no);
    if (!matchedCase) {
      const info = db
        .prepare(`INSERT INTO cases (client_name, phone, court, court_case_no, assignee_name, memo, case_type, intake_date, assigned_lawyer, current_stage, status, created_by, updated_at)
                  VALUES (?, '', ?, ?, ?, '', '', '', '', '', '사건진행중', ?, datetime('now'))`)
        .run(t.client_name, t.court || '', t.court_case_no || '', t.assignee_name || '', adminUserId);
      matchedCase = { id: info.lastInsertRowid, client_name: t.client_name, _sortKey: info.lastInsertRowid };
      realCases.push(matchedCase);
      createdCases++;
    }

    db.prepare(`INSERT INTO case_tasks (case_id, task_type, received_date, due_date, status, assignee_name, memo, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(matchedCase.id, t.task_type, t.received_date || '', t.due_date, t.status, t.assignee_name || '', t.memo || '', adminUserId);
    migrated++;
  }

  db.prepare("UPDATE google_auth SET tasks_source = 'app' WHERE id = 1").run();
  return { migrated, createdCases, alreadyApp: false };
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
  const { id, username, name, role, email, allowed_tabs } = req.user;
  res.json({ id, username, name, role, email, allowed_tabs });
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
  res.json(db.prepare('SELECT id, username, email, name, role, allowed_tabs FROM employees ORDER BY id').all());
});

// allowed_tabs로 들어온 값(배열 또는 콤마 문자열)을 RESTRICTABLE_TABS 안에서만 걸러
// 콤마 문자열로 정리한다. 필드 자체가 안 왔으면(undefined) "건드리지 않음"을 의미하도록
// undefined를 그대로 돌려주고, 빈 배열([])은 반드시 빈 문자열('')로 저장해야 한다 —
// ''(제한된 탭 전부 차단)과 null(제한 없음, 전체 허용)은 의미가 정반대라서, 여기서 ''를
// null로 뭉개버리면 "탭을 전부 해제한 직원"이 도리어 전체 접근 권한을 갖게 되는
// 심각한 보안 버그가 된다.
function normalizeAllowedTabs(input) {
  if (input === undefined) return undefined; // 필드 자체가 안 옴 -> 기존 값 유지(PATCH) / NULL(POST)
  if (input === null) return null; // 명시적으로 null -> 제한 없음으로 초기화
  const arr = Array.isArray(input) ? input : String(input).split(',');
  const cleaned = arr.map((s) => String(s).trim()).filter((s) => RESTRICTABLE_TABS.includes(s));
  return cleaned.join(','); // 빈 배열이면 '' 그대로 반환 (null과 구분되어야 함)
}

app.post('/api/employees', requireAdmin, async (req, res) => {
  const { username, password, name, email, role, allowed_tabs } = req.body || {};
  if (!username || !password || !name) return res.status(400).json({ error: '아이디, 비밀번호, 이름은 필수입니다.' });
  try {
    // allowed_tabs를 아예 안 보내면(예: 예전 클라이언트) 전체 허용(NULL)으로 남겨 기존 동작 유지.
    const normalizedTabs = normalizeAllowedTabs(allowed_tabs);
    const info = db
      .prepare(`INSERT INTO employees (username, email, password_hash, name, role, allowed_tabs) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(username, email || '', hashPassword(password), name, role === 'admin' ? 'admin' : 'employee', normalizedTabs === undefined ? null : normalizedTabs);

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
  const { name, email, password, role, allowed_tabs } = req.body || {};
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!emp) return res.status(404).json({ error: '직원을 찾을 수 없습니다.' });

  const fields = [];
  const values = [];
  if (name) { fields.push('name = ?'); values.push(name); }
  if (email !== undefined) { fields.push('email = ?'); values.push(email); }
  if (role) { fields.push('role = ?'); values.push(role === 'admin' ? 'admin' : 'employee'); }
  if (password) { fields.push('password_hash = ?'); values.push(hashPassword(password)); }
  const normalizedTabs = normalizeAllowedTabs(allowed_tabs);
  if (normalizedTabs !== undefined) { fields.push('allowed_tabs = ?'); values.push(normalizedTabs); }
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
  // 관리자 전용 비공개 일정(수임료 납부일정 등)은 직원 계정의 월/주/일 캘린더 어디에도
  // 노출되면 안 되므로, 목록을 만드는 이 지점에서 항상 걸러낸다.
  const isAdmin = req.user.role === 'admin';
  let rows;
  if (start && end) {
    const privacySql = isAdmin ? '' : 'AND s.is_private = 0';
    rows = db
      .prepare(`SELECT s.*, e.name AS creator_name FROM schedules s JOIN employees e ON e.id = s.created_by
                WHERE s.start_at < ? AND s.end_at > ? ${privacySql} ORDER BY s.start_at`)
      .all(end, start);
  } else {
    const privacySql = isAdmin ? '' : 'WHERE s.is_private = 0';
    rows = db
      .prepare(`SELECT s.*, e.name AS creator_name FROM schedules s JOIN employees e ON e.id = s.created_by ${privacySql} ORDER BY s.start_at`)
      .all();
  }
  res.json(rows);
});

// PC "오늘 할일" 미니 창(Picture-in-Picture)용 요약. 팀 스케줄(오늘)과 사건관리(오늘 마감,
// '연기'는 제외)를 한 번에 반환한다. /api/schedules는 start_at===end_at(종일 일정)인 경우
// 그날 일정을 못 찾는 경계값 문제가 있어(부등호 비교) 여기서는 카카오 알림과 같은 방식으로
// substr 비교를 직접 쓴다 - getTodaysCaseTasksForNotify()도 그대로 재사용한다(OSMU).
app.get('/api/today', requireLogin, async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const todayStr = kstDateStringPlusDays(0);
  const privacySql = isAdmin ? '' : 'AND is_private = 0';
  const schedules = db
    .prepare(`SELECT * FROM schedules WHERE substr(start_at, 1, 10) = ? ${privacySql} ORDER BY id`)
    .all(todayStr);
  const caseTasks = await getTodaysCaseTasksForNotify();
  res.json({ schedules, caseTasks });
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

  // 관리자 전용 비공개 일정(수임료 납부일정 등)은 구글 캘린더가 다른 사람과 공유되어
  // 있을 수 있으므로 절대 내보내지 않는다.
  if (!fresh.is_private) {
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
  }

  res.json(fresh);
});

app.delete('/api/schedules/:id', requireLogin, async (req, res) => {
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  if (!schedule) return res.status(404).json({ error: '일정을 찾을 수 없습니다.' });
  if (!canModifySchedule(req.user, schedule)) return res.status(403).json({ error: '본인이 등록한 일정만 삭제할 수 있습니다.' });

  db.prepare('DELETE FROM schedules WHERE id = ?').run(schedule.id);
  // 수임료 납부일정이 만들어둔 일정이었다면, 참조가 끊긴 채 남지 않도록 연결을 정리한다
  // (다음에 해당 납부 회차를 수정하면 이 함수가 새 일정을 다시 만들어 연결한다).
  db.prepare('UPDATE case_fee_installments SET schedule_id = NULL WHERE schedule_id = ?').run(schedule.id);

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
  const { client_name, phone, court, court_case_no, assignee_name, memo, case_type, intake_date, consult_date, assigned_lawyer, current_stage, status, region, consult_report_json } = req.body || {};
  if (!client_name) return res.status(400).json({ error: '의뢰인명은 필수입니다.' });

  const info = db
    .prepare(`INSERT INTO cases (client_name, phone, court, court_case_no, assignee_name, memo, case_type, intake_date, consult_date, assigned_lawyer, current_stage, status, region, consult_report_json, created_by, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(
      client_name, phone || '', court || '', court_case_no || '', assignee_name || '', memo || '',
      case_type || '', intake_date || '', consult_date || '', assigned_lawyer || '', current_stage || '', status || '', region || '',
      consult_report_json || null, req.user.id
    );

  res.status(201).json(db.prepare('SELECT * FROM cases WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/cases/:id', requireLogin, (req, res) => {
  const existing = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  const {
    client_name, phone, court, court_case_no, assignee_name, memo, case_type, intake_date, consult_date, assigned_lawyer, current_stage, status,
    seal_received, seal_received_date, cert_usb_received, cert_usb_received_date, region, consult_report_json,
    client_grade, client_grade_reason, birth_date,
  } = req.body || {};

  // 생년월일은 의뢰인용 진행현황 조회의 본인확인 값이라 형식이 어긋나면 그 즉시 조회 불가로
  // 이어진다 — 자유형식으로 저장하지 않고 다른 날짜칸(상담일/접수일 등)과 동일한 yyyy-mm-dd만 허용한다.
  if (birth_date !== undefined && birth_date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(birth_date)) {
    return res.status(400).json({ error: '생년월일은 yyyy-mm-dd 형식으로 입력해주세요.' });
  }

  // 고객등급/드롭사유는 관리자만 수정 가능 — 요청에 값이 담겨 있는데 관리자가 아니면 요청 전체를 거부한다
  // (일부만 조용히 무시하면 "분명 저장했는데 안 바뀌었다"는 혼란을 만들 수 있어서).
  if ((client_grade !== undefined || client_grade_reason !== undefined) && req.user.role !== 'admin') {
    return res.status(403).json({ error: '고객등급은 관리자만 수정할 수 있습니다.' });
  }
  if (client_grade !== undefined && client_grade !== '' && client_grade !== null && !CLIENT_GRADES.includes(String(client_grade))) {
    return res.status(400).json({ error: '올바르지 않은 고객등급입니다.' });
  }
  const finalGrade = client_grade !== undefined ? client_grade : existing.client_grade;
  // 드롭(5)이 아닌 등급이면 이전에 남아있던 드롭 사유는 의미가 없으므로 같이 지운다.
  let resolvedGradeReason = finalGrade !== '5' ? '' : (client_grade_reason !== undefined ? client_grade_reason : existing.client_grade_reason);
  if (finalGrade === '5') {
    if (!resolvedGradeReason) {
      return res.status(400).json({ error: '드롭 사유를 선택해야 합니다.' });
    }
    if (!DROP_REASONS.includes(resolvedGradeReason)) {
      return res.status(400).json({ error: '올바르지 않은 드롭 사유입니다.' });
    }
  }

  const updated = {
    client_name: client_name ?? existing.client_name,
    phone: phone ?? existing.phone,
    court: court ?? existing.court,
    court_case_no: court_case_no ?? existing.court_case_no,
    assignee_name: assignee_name ?? existing.assignee_name,
    memo: memo ?? existing.memo,
    case_type: case_type ?? existing.case_type,
    intake_date: intake_date ?? existing.intake_date,
    consult_date: consult_date ?? existing.consult_date,
    assigned_lawyer: assigned_lawyer ?? existing.assigned_lawyer,
    current_stage: current_stage ?? existing.current_stage,
    status: status ?? existing.status,
    seal_received: seal_received !== undefined ? (seal_received ? 1 : 0) : existing.seal_received,
    seal_received_date: seal_received_date ?? existing.seal_received_date,
    cert_usb_received: cert_usb_received !== undefined ? (cert_usb_received ? 1 : 0) : existing.cert_usb_received,
    cert_usb_received_date: cert_usb_received_date ?? existing.cert_usb_received_date,
    region: region ?? existing.region,
    consult_report_json: consult_report_json ?? existing.consult_report_json,
    client_grade: finalGrade ?? existing.client_grade,
    client_grade_reason: resolvedGradeReason,
    birth_date: birth_date ?? existing.birth_date,
  };
  db.prepare(`UPDATE cases SET client_name=?, phone=?, court=?, court_case_no=?, assignee_name=?, memo=?, case_type=?, intake_date=?, consult_date=?, assigned_lawyer=?, current_stage=?, status=?,
              seal_received=?, seal_received_date=?, cert_usb_received=?, cert_usb_received_date=?, region=?, consult_report_json=?,
              client_grade=?, client_grade_reason=?, birth_date=?, updated_at=datetime('now') WHERE id = ?`)
    .run(
      updated.client_name, updated.phone, updated.court, updated.court_case_no, updated.assignee_name, updated.memo,
      updated.case_type, updated.intake_date, updated.consult_date, updated.assigned_lawyer, updated.current_stage, updated.status,
      updated.seal_received, updated.seal_received_date, updated.cert_usb_received, updated.cert_usb_received_date,
      updated.region, updated.consult_report_json,
      updated.client_grade, updated.client_grade_reason, updated.birth_date,
      existing.id
    );

  res.json(db.prepare('SELECT * FROM cases WHERE id = ?').get(existing.id));
});

// 알림톡 발송 기록: "알림톡 2회 · 마지막 9/1"처럼 직원이 재확인 없이 바로 볼 수 있게 누적한다.
// 등급과 달리 알림톡 발송 자체는 실무자 누구나 하는 일이라 관리자 제한을 두지 않는다.
app.post('/api/cases/:id/alimtalk-log', requireLogin, (req, res) => {
  const existing = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  db.prepare(`UPDATE cases SET alimtalk_count = COALESCE(alimtalk_count, 0) + 1, alimtalk_last_sent = datetime('now') WHERE id = ?`)
    .run(existing.id);

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

  // 수임료 납부일정은 더 이상 팀 스케줄과 동기화되지 않으므로(수임료 전용 캘린더에서만 관리) 그냥 지운다.
  db.prepare('DELETE FROM case_fee_installments WHERE case_id = ?').run(existing.id);
  db.prepare('DELETE FROM case_fees WHERE case_id = ?').run(existing.id);
  db.prepare('DELETE FROM case_files WHERE case_id = ?').run(existing.id);
  db.prepare('DELETE FROM case_stage_events WHERE case_id = ?').run(existing.id);
  db.prepare('DELETE FROM cases WHERE id = ?').run(existing.id);

  const filesDir = path.join(UPLOADS_DIR, `case-${existing.id}`);
  if (fs.existsSync(filesDir)) fs.rmSync(filesDir, { recursive: true, force: true });

  res.json({ ok: true });
});

/* ---- /api/cases/:id/files (상담레포트 등 첨부파일) ---- */

app.get('/api/cases/:id/files', requireLogin, (req, res) => {
  const existing = db.prepare('SELECT id FROM cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });
  const files = db.prepare('SELECT * FROM case_files WHERE case_id = ? ORDER BY id DESC').all(req.params.id);
  res.json(files);
});

app.post('/api/cases/:id/files', requireLogin, (req, res) => {
  const existing = db.prepare('SELECT id FROM cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  uploadCaseFile.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '파일 용량은 20MB를 넘을 수 없습니다.' : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: '업로드할 파일을 선택해주세요.' });

    const info = db
      .prepare(`INSERT INTO case_files (case_id, category, original_name, stored_name, size, uploaded_by)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(existing.id, (req.body && req.body.category) || '', req.file.originalname, req.file.filename, req.file.size, req.user.id);

    res.status(201).json(db.prepare('SELECT * FROM case_files WHERE id = ?').get(info.lastInsertRowid));
  });
});

app.get('/api/case-files/:fileId/download', requireLogin, (req, res) => {
  const file = db.prepare('SELECT * FROM case_files WHERE id = ?').get(req.params.fileId);
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  const filePath = path.join(UPLOADS_DIR, `case-${file.case_id}`, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '파일이 서버에 존재하지 않습니다.' });
  res.download(filePath, file.original_name);
});

// 첨부문서를 다운로드시키지 않고 새 탭/팝업에서 바로 열람할 때 쓴다 (PDF·이미지는 브라우저가
// 자체 뷰어로 바로 렌더링 — Content-Disposition을 inline으로 주는 게 핵심이다).
app.get('/api/case-files/:fileId/view', requireLogin, (req, res) => {
  const file = db.prepare('SELECT * FROM case_files WHERE id = ?').get(req.params.fileId);
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  const filePath = path.join(UPLOADS_DIR, `case-${file.case_id}`, file.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '파일이 서버에 존재하지 않습니다.' });
  const ext = path.extname(file.stored_name).toLowerCase();
  const mime = CASE_FILE_MIME[ext] || 'application/octet-stream';
  const safeName = (file.original_name || '').replace(/["\\\r\n]/g, '');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(safeName)}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
  res.sendFile(filePath);
});

app.delete('/api/case-files/:fileId', requireAdmin, (req, res) => {
  const file = db.prepare('SELECT * FROM case_files WHERE id = ?').get(req.params.fileId);
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });

  const filePath = path.join(UPLOADS_DIR, `case-${file.case_id}`, file.stored_name);
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (err) { console.error('첨부파일 삭제 실패:', err.message); }
  db.prepare('DELETE FROM case_files WHERE id = ?').run(file.id);

  res.json({ ok: true });
});

/* ---- /api/cases/:id/stage-events (의뢰인용 진행현황 타임라인 기록) ---- */

app.get('/api/cases/:id/stage-events', requireLogin, (req, res) => {
  const existing = db.prepare('SELECT id FROM cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });
  const events = db.prepare('SELECT * FROM case_stage_events WHERE case_id = ? ORDER BY event_date ASC, id ASC').all(req.params.id);
  res.json(events);
});

app.post('/api/cases/:id/stage-events', requireLogin, (req, res) => {
  const existing = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  const { stage, event_date } = req.body || {};
  const allowedStages = CASE_STAGE_TIMELINE[existing.case_type] || [];
  if (!allowedStages.includes(stage)) {
    return res.status(400).json({ error: '이 사건유형에서는 사용할 수 없는 단계입니다.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event_date || '')) {
    return res.status(400).json({ error: '날짜는 yyyy-mm-dd 형식으로 입력해주세요.' });
  }

  const info = db
    .prepare('INSERT INTO case_stage_events (case_id, stage, event_date, created_by) VALUES (?, ?, ?, ?)')
    .run(existing.id, stage, event_date, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM case_stage_events WHERE id = ?').get(info.lastInsertRowid));
});

app.delete('/api/case-stage-events/:eventId', requireLogin, (req, res) => {
  const event = db.prepare('SELECT * FROM case_stage_events WHERE id = ?').get(req.params.eventId);
  if (!event) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
  db.prepare('DELETE FROM case_stage_events WHERE id = ?').run(event.id);
  res.json({ ok: true });
});

/* ---- /api/cases/:id/fee (수임료 총액 + 회차별 분할납부) ---- */

const FEE_INSTALLMENT_STATUSES = ['예정', '완료'];
const FEE_PAYMENT_METHODS = ['현금', '계좌이체', '신용카드'];

// 금액(원)을 "105만원"처럼 만원 단위 문자열로 바꾼다. 팀 스케줄 제목에서 한눈에 금액을
// 알아볼 수 있도록 하기 위함이며, 만원 단위로 딱 안 떨어지는 금액은 소수 첫째자리까지 표시한다.
function formatManwon(amount) {
  const man = Math.round((Number(amount) || 0) / 1000) / 10;
  return (Number.isInteger(man) ? man : man.toFixed(1)).toString();
}

// (예전에는 여기서 수임료 납부회차를 팀 스케줄의 비공개 일정과 동기화했다. 팀 스케줄이 수임료
// 일정으로 지저분해진다는 피드백에 따라 2026-08부터는 수임료 전용 캘린더(fee-calendar.html,
// /api/admin/fee-calendar)에서만 보여주고 팀 스케줄과는 더 이상 연동하지 않는다.)

app.get('/api/cases/:id/fee', requireTab('fee'), (req, res) => {
  const existing = db.prepare('SELECT id FROM cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  const fee = db.prepare('SELECT * FROM case_fees WHERE case_id = ?').get(existing.id) || { case_id: existing.id, total_amount: 0, memo: '' };
  const installments = db.prepare('SELECT * FROM case_fee_installments WHERE case_id = ? ORDER BY seq ASC, id ASC').all(existing.id);
  res.json({ total_amount: fee.total_amount, memo: fee.memo || '', installments });
});

app.put('/api/cases/:id/fee', requireTab('fee'), (req, res) => {
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

app.post('/api/cases/:id/fee-installments', requireTab('fee'), (req, res) => {
  const existing = db.prepare('SELECT id FROM cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  const { seq, amount, due_date, status, paid_date, memo, payment_method, payer_name } = req.body || {};
  const safeStatus = FEE_INSTALLMENT_STATUSES.includes(status) ? status : '예정';
  const safeMethod = FEE_PAYMENT_METHODS.includes(payment_method) ? payment_method : '';

  // 새로 추가하면서 바로 "완료"로 만드는 경우는 화면에서 사람이 직접 입력한 것이므로 수동으로 기록한다.
  const matchSource = safeStatus === '완료' ? '수동' : '';

  const info = db.prepare(`
    INSERT INTO case_fee_installments (case_id, seq, amount, due_date, status, paid_date, memo, payment_method, payer_name, match_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(existing.id, Number(seq) || 1, Number(amount) || 0, due_date || '', safeStatus, safeStatus === '완료' ? (paid_date || '') : '', memo || '', safeMethod, String(payer_name || '').trim(), matchSource);

  const installment = db.prepare('SELECT * FROM case_fee_installments WHERE id = ?').get(info.lastInsertRowid);

  res.status(201).json(installment);
});

app.patch('/api/fee-installments/:id', requireTab('fee'), (req, res) => {
  const existing = db.prepare('SELECT * FROM case_fee_installments WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '납부 회차를 찾을 수 없습니다.' });

  const { seq, amount, due_date, status, paid_date, memo, payment_method, payer_name } = req.body || {};
  const safeStatus = status !== undefined ? (FEE_INSTALLMENT_STATUSES.includes(status) ? status : existing.status) : existing.status;
  const updated = {
    seq: seq !== undefined ? (Number(seq) || existing.seq) : existing.seq,
    amount: amount !== undefined ? (Number(amount) || 0) : existing.amount,
    due_date: due_date ?? existing.due_date,
    status: safeStatus,
    paid_date: safeStatus === '완료' ? (paid_date ?? existing.paid_date ?? '') : '',
    memo: memo ?? existing.memo,
    payment_method: payment_method !== undefined ? (FEE_PAYMENT_METHODS.includes(payment_method) ? payment_method : '') : (existing.payment_method || ''),
    payer_name: payer_name !== undefined ? String(payer_name || '').trim() : (existing.payer_name || ''),
  };
  // match_source(자동/수동): 이 화면(사건상세)에서 예정 → 완료로 바꾸는 순간은 사람이 직접 체크한
  // 것이므로 '수동'으로 기록한다. 이미 완료 상태였던 걸 다른 항목만 고치는 경우(예: 메모 수정)는
  // 기존에 통장매칭으로 자동확인된 기록을 덮어쓰지 않도록 그대로 둔다. 완료를 다시 예정으로
  // 되돌리면 더 이상 해당 없으므로 비운다.
  let matchSource = existing.match_source || '';
  if (updated.status === '완료' && existing.status !== '완료') matchSource = '수동';
  else if (updated.status !== '완료') matchSource = '';

  db.prepare(`UPDATE case_fee_installments SET seq=?, amount=?, due_date=?, status=?, paid_date=?, memo=?, payment_method=?, payer_name=?, match_source=?, updated_at=datetime('now') WHERE id = ?`)
    .run(updated.seq, updated.amount, updated.due_date, updated.status, updated.paid_date, updated.memo, updated.payment_method, updated.payer_name, matchSource, existing.id);

  const fresh = db.prepare('SELECT * FROM case_fee_installments WHERE id = ?').get(existing.id);

  res.json(fresh);
});

app.delete('/api/fee-installments/:id', requireTab('fee'), (req, res) => {
  const existing = db.prepare('SELECT * FROM case_fee_installments WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: '납부 회차를 찾을 수 없습니다.' });
  db.prepare('DELETE FROM case_fee_installments WHERE id = ?').run(existing.id);
  res.json({ ok: true });
});

/* ---- 수임료 전용 캘린더 (관리자 전용) ----
   팀 스케줄과는 완전히 분리된, 읽기 전용 뷰다. case_fee_installments가 원본이므로(OSMU)
   이 화면은 데이터를 새로 만들지 않고 항상 그 원본을 그대로 읽어서 보여준다. */

app.get('/api/admin/fee-calendar', requireTab('fee'), (req, res) => {
  const { start, end } = req.query;
  const start10 = start ? String(start).slice(0, 10) : null;
  const end10 = end ? String(end).slice(0, 10) : null;

  const conditions = ["fi.due_date IS NOT NULL", "fi.due_date != ''"];
  const params = [];
  if (start10) { conditions.push('fi.due_date >= ?'); params.push(start10); }
  if (end10) { conditions.push('fi.due_date < ?'); params.push(end10); }

  const rows = db
    .prepare(
      `SELECT fi.*, c.client_name FROM case_fee_installments fi
       JOIN cases c ON c.id = fi.case_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY fi.due_date ASC`
    )
    .all(...params);
  res.json(rows);
});

// "정산기간": 매달 25일 ~ 다음달 24일 (예상수임료 집계 기준). 오늘 실제 날짜를 기준으로
// 항상 고정 계산한다 — 캘린더 화면에서 다른 달로 이동해도 사이드 요약은 이 기간에서 바뀌지 않는다.
function computeSettlementPeriod(today) {
  const y = today.getFullYear();
  const m = today.getMonth(); // 0-indexed
  const pad2 = (n) => String(n).padStart(2, '0');
  let startY, startM, endY, endM;
  if (today.getDate() >= 25) {
    startY = y; startM = m;
    endY = m === 11 ? y + 1 : y; endM = (m + 1) % 12;
  } else {
    endY = y; endM = m;
    startY = m === 0 ? y - 1 : y; startM = m === 0 ? 11 : m - 1;
  }
  return {
    start: `${startY}-${pad2(startM + 1)}-25`,
    end: `${endY}-${pad2(endM + 1)}-24`,
  };
}

app.get('/api/admin/fee-calendar/period-summary', requireTab('fee'), (req, res) => {
  const { start, end } = computeSettlementPeriod(new Date());
  const rows = db
    .prepare(
      `SELECT status, COALESCE(SUM(amount), 0) AS total FROM case_fee_installments
       WHERE due_date >= ? AND due_date <= ? GROUP BY status`
    )
    .all(start, end);
  let completed = 0;
  let upcoming = 0;
  rows.forEach((r) => {
    if (r.status === '완료') completed += r.total;
    else upcoming += r.total;
  });
  res.json({ start, end, completed, upcoming, total: completed + upcoming });
});

// "미납자 리스트": 납부예정일이 이미 지났는데도 아직 '완료' 처리되지 않은 회차를 의뢰인별로
// 묶어서 보여준다. 정산기간과 무관하게(과거 기간 포함) 항상 "지금 기준으로 밀린 사람"을
// 그대로 보여주는 것이 실무에서 가장 유용하므로 기간 필터는 두지 않는다.
app.get('/api/admin/fee-calendar/overdue', requireTab('fee'), (req, res) => {
  const today = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const todayStr = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

  const rows = db
    .prepare(
      `SELECT fi.id, fi.case_id, fi.seq, fi.amount, fi.due_date, c.client_name, c.phone
       FROM case_fee_installments fi
       JOIN cases c ON c.id = fi.case_id
       WHERE fi.status != '완료' AND fi.due_date IS NOT NULL AND fi.due_date != '' AND fi.due_date < ?
       ORDER BY fi.due_date ASC`
    )
    .all(todayStr);

  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const byCase = new Map();
  rows.forEach((r) => {
    const [y, m, d] = r.due_date.slice(0, 10).split('-').map(Number);
    const daysOverdue = Math.round((todayUtc - Date.UTC(y, m - 1, d)) / 86400000);
    if (!byCase.has(r.case_id)) {
      byCase.set(r.case_id, {
        case_id: r.case_id,
        client_name: r.client_name,
        phone: r.phone,
        total_overdue: 0,
        max_days_overdue: 0,
        installments: [],
      });
    }
    const entry = byCase.get(r.case_id);
    entry.total_overdue += r.amount;
    entry.max_days_overdue = Math.max(entry.max_days_overdue, daysOverdue);
    entry.installments.push({ id: r.id, seq: r.seq, amount: r.amount, due_date: r.due_date, days_overdue: daysOverdue });
  });

  const clients = Array.from(byCase.values()).sort((a, b) => b.max_days_overdue - a.max_days_overdue);
  res.json({ today: todayStr, clients, totalAmount: clients.reduce((sum, c) => sum + c.total_overdue, 0) });
});

/* ---- 수임료 통장거래내역 매칭 (관리자 전용) ----
   은행에서 받은 거래내역 엑셀(.xls/.xlsx)을 업로드하면, 입금 건들을 미납(예정) 상태인
   납부회차와 "금액 + 입금자명"으로 자동 매칭해서 미리보기만 보여준다. 실제로 완료 처리는
   관리자가 확인 후 /confirm-matches를 호출할 때만 이뤄지고, 자동으로는 절대 반영하지 않는다
   (동명이인·분할입금 등으로 오매칭이 나면 수임료 데이터가 틀어질 수 있기 때문).
   원본 엑셀은 디스크에 저장하지 않고 이 요청을 처리하는 동안만 메모리에서 읽는다. */

const bankStatementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.xls', '.xlsx', '.csv'].includes(ext)) {
      return cb(new Error('엑셀(.xls/.xlsx) 또는 CSV 파일만 업로드할 수 있습니다.'));
    }
    cb(null, true);
  },
});

const BANK_DATE_HEADERS = ['거래일자', '거래일', '날짜'];
const BANK_DEPOSIT_HEADERS = ['입금(원)', '입금액', '입금'];
const BANK_MEMO_HEADERS = ['내용', '적요2', '보낸분', '보낸사람', '입금자명', '메모'];

// 엑셀 원본 위쪽에는 계좌번호/조회기간 같은 안내 줄이 은행마다 다른 줄 수만큼 붙어있어서,
// 실제 표 헤더("거래일자" 등)가 몇 번째 줄인지 매번 다르다. 앞 20줄 안에서 찾는다.
function findBankHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = (rows[i] || []).map((c) => String(c == null ? '' : c).trim());
    if (row.some((c) => BANK_DATE_HEADERS.includes(c))) return { index: i, header: row };
  }
  return null;
}

function findColumn(header, aliases, exclude) {
  for (const alias of aliases) {
    const idx = header.findIndex((h) => h === alias);
    if (idx >= 0) return idx;
  }
  for (const alias of aliases) {
    const idx = header.findIndex((h) => h.includes(alias) && (!exclude || !h.includes(exclude)));
    if (idx >= 0) return idx;
  }
  return -1;
}

// 엑셀 날짜 셀이 "2026-01-02" 같은 문자열이 아니라 진짜 날짜 서식(일련번호)으로 들어있는
// 은행 양식도 있어서, 숫자로 오면 엑셀 날짜 기준일(1899-12-30)로부터 다시 계산해준다.
function excelSerialToISODate(serial) {
  const utcDays = Math.floor(Number(serial) - 25569);
  const d = new Date(utcDays * 86400 * 1000);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function parseBankStatement(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  const headerInfo = findBankHeaderRow(rows);
  if (!headerInfo) throw new Error('거래내역 표를 찾지 못했습니다 ("거래일자" 컬럼이 있는 은행 원본 파일인지 확인해주세요).');
  const { index: headerIdx, header } = headerInfo;
  const dateCol = findColumn(header, BANK_DATE_HEADERS);
  const depositCol = findColumn(header, BANK_DEPOSIT_HEADERS, '출금');
  const memoCol = findColumn(header, BANK_MEMO_HEADERS);
  if (dateCol < 0 || depositCol < 0) {
    throw new Error('"거래일자"와 "입금(원)" 컬럼을 인식하지 못했습니다. 은행에서 받은 원본 거래내역 엑셀인지 확인해주세요.');
  }

  const deposits = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c === '' || c === undefined || c === null)) continue;
    const amount = Number(row[depositCol]) || 0;
    if (amount <= 0) continue; // 출금 건은 매칭 대상이 아니다.
    const rawDate = row[dateCol];
    const date = typeof rawDate === 'number'
      ? excelSerialToISODate(rawDate)
      : String(rawDate || '').trim().slice(0, 10).replace(/[./]/g, '-');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const memo = memoCol >= 0 ? String(row[memoCol] || '').trim() : '';
    deposits.push({ date, amount, memo });
  }
  return deposits;
}

// 입금 메모(보낸사람 이름)가 이 회차와 관련 있는지 확인한다. 원칙적으로 의뢰인 본인 이름과
// 비교하지만, 가족이 대신 납부하는 경우가 있어(예: 자녀가 부모 몫을 대신 입금) 회차에 미리
// "입금자명(payer_name)"을 등록해두면 그 이름으로도 매칭할 수 있게 한다.
function memoMatchesInst(dep, inst) {
  if (!dep.memo) return false;
  if (inst.client_name && dep.memo.startsWith(inst.client_name.trim())) return true;
  if (inst.payer_name && dep.memo.startsWith(inst.payer_name.trim())) return true;
  return false;
}

app.post('/api/admin/fee-calendar/import-preview', requireTab('fee'), (req, res) => {
  bankStatementUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '업로드할 거래내역 파일을 선택해주세요.' });

    let deposits;
    try {
      deposits = parseBankStatement(req.file.buffer);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    // 매칭 후보 풀: 아직 미납(예정)인 모든 납부회차를 금액별로 묶어둔다. 이름+금액이 유일하게
    // 일치해 자동 확정되는 순간 그 회차는 풀에서 빼서, 같은 회차가 다른 입금 건에 또 잡히지 않게 한다.
    const unpaid = db
      .prepare(
        `SELECT fi.*, c.client_name FROM case_fee_installments fi
         JOIN cases c ON c.id = fi.case_id WHERE fi.status = '예정'`
      )
      .all();
    const pool = new Map();
    unpaid.forEach((inst) => {
      if (!pool.has(inst.amount)) pool.set(inst.amount, []);
      pool.get(inst.amount).push(inst);
    });

    // 같은 의뢰인의 미납 회차를 이름별로도 묶어둔다 — 여러 회차를 한 번에 몰아서 낸 경우
    // (예: 4월분+5월분을 5월에 합쳐서 납부) 금액이 아니라 "그 사람의 미납 회차 누적 합"으로
    // 찾아야 하기 때문이다. pool과 같은 installment 객체를 공유하므로 removeFromPool()로
    // 하나를 빼면 여기서도 함께 빠진다.
    const byName = new Map();
    unpaid.forEach((inst) => {
      if (!inst.client_name) return;
      if (!byName.has(inst.client_name)) byName.set(inst.client_name, []);
      byName.get(inst.client_name).push(inst);
    });
    byName.forEach((list) => list.sort((a, b) => (a.due_date || '').localeCompare(b.due_date || '')));

    function removeFromPool(inst) {
      const amtArr = pool.get(inst.amount);
      if (amtArr) { const i = amtArr.indexOf(inst); if (i >= 0) amtArr.splice(i, 1); }
      const nameArr = byName.get(inst.client_name);
      if (nameArr) { const i = nameArr.indexOf(inst); if (i >= 0) nameArr.splice(i, 1); }
    }

    // 이미 완료 처리된(수동으로 직접 체크했든, 예전에 통장매칭으로 확정됐든) 회차도 이름+금액
    // 기준으로 따로 묶어둔다 — 그 회차의 입금 건은 통장매칭 기록이 남아있지 않아도 이미 처리가
    // 끝난 것이므로, 미매칭/확인필요 목록에 노이즈로 띄우지 않고 그냥 건너뛴다. 단, 같은 이름·
    // 금액의 회차를 이미 하나 완료 처리했다고 해서 그 사람의 "다른" 미납 회차(같은 금액)까지
    // 전부 이미 처리된 것으로 착각하면 안 되므로, 확인할 때마다 하나씩 소모(splice)한다.
    const paid = db
      .prepare(
        `SELECT fi.*, c.client_name FROM case_fee_installments fi
         JOIN cases c ON c.id = fi.case_id WHERE fi.status = '완료'`
      )
      .all();
    const paidPool = new Map();
    paid.forEach((inst) => {
      if (!paidPool.has(inst.amount)) paidPool.set(inst.amount, []);
      paidPool.get(inst.amount).push(inst);
    });

    // 이미 완료 처리된 회차 중 "그 입금일까지 정확히 기록되어 있는" 건은 별도로 더 강하게
    // 체크한다 — 이름+금액+입금일(paid_date)이 통장 입금 건과 완전히 똑같으면, 그 입금은
    // 이미 그 회차를 낸 걸로 확정된 게 100% 확실하다(같은 입금이 두 번 들어올 리 없으므로).
    // 이 체크는 미납 회차 매칭(1~3단계)보다도 먼저 해야 한다 — 그렇지 않으면, 마침 같은
    // 이름·같은 금액의 "다른" 미납 회차가 남아있을 때 이미 다른 회차에 쓰인 입금 하나를
    // 두 회차의 증거로 중복 사용해버리는 사고가 난다(예: 신해숙 7/23 입금이 이미 3회차
    // paid_date로 기록되어 있는데, 4회차도 같은 금액이라 그쪽으로 또 매칭되어버리는 경우).
    const exactPaidDateMap = new Map(); // key: name|amount|date -> count
    paid.forEach((inst) => {
      if (!inst.client_name || !inst.paid_date) return;
      const key = `${inst.client_name}|${inst.amount}|${inst.paid_date}`;
      exactPaidDateMap.set(key, (exactPaidDateMap.get(key) || 0) + 1);
    });

    // 이전에 "사건과 무관함(상담료 등)"으로 표시해둔 입금 목록 (날짜+금액+메모가 완전히
    // 같아야 같은 거래로 본다 — 통장내역 재분석 시 이 목록에 있으면 매번 조용히 건너뛴다.
    const ignoredKeys = new Set(
      db.prepare('SELECT deposit_date, amount, memo FROM fee_calendar_ignored_deposits').all()
        .map((d) => `${d.deposit_date}|${d.amount}|${d.memo}`)
    );

    const matched = []; // 이름+금액 유일 일치(또는 합산 일치) - 미리보기에서 기본 체크됨
    const review = []; // 후보가 여러 건이거나 금액만 맞음 - 사람이 직접 골라야 함
    const unmatched = []; // 후보가 아예 없음 (수임료가 아닌 입금일 가능성)
    let alreadyHandledCount = 0;
    let ignoredCount = 0;

    deposits
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .forEach((dep) => {
        // -1) 사건과 무관하다고 이미 표시해둔 입금이면(예: 상담료), 더 볼 것 없이 건너뛴다.
        const ignoreKey = `${dep.date}|${dep.amount}|${dep.memo || ''}`;
        if (ignoredKeys.has(ignoreKey)) { ignoredCount++; return; }

        // 0) 이 입금(이름+금액+날짜)이 이미 완료 처리된 어떤 회차의 paid_date와 정확히 똑같으면,
        //    그 회차를 위한 입금이 확실하므로 더 볼 것 없이 "이미 처리됨"으로 건너뛴다.
        if (dep.memo) {
          let exactName = null;
          const poolFlat = [...pool.values()].flat();
          const exactFromPool = poolFlat.find((c) => memoMatchesInst(dep, c));
          if (exactFromPool) exactName = exactFromPool.client_name;
          // pool에 이름이 없을 수도 있으니(완료 회차만 있는 사람) paidPool 쪽 이름도 함께 확인
          if (!exactName) {
            const exactFromPaid = paid.find((inst) => memoMatchesInst(dep, inst));
            if (exactFromPaid) exactName = exactFromPaid.client_name;
          }
          if (exactName) {
            const exactKey = `${exactName}|${dep.amount}|${dep.date}`;
            const count = exactPaidDateMap.get(exactKey) || 0;
            if (count > 0) {
              exactPaidDateMap.set(exactKey, count - 1);
              alreadyHandledCount++;
              return;
            }
          }
        }

        // 1) 미납 회차 중 이름+금액이 정확히 하나만 맞는 경우 - 가장 확실한 매칭이므로 항상
        //    최우선으로 확인한다("이미 처리됨"보다 먼저 봐야, 같은 사람의 다른 미납 회차가
        //    엉뚱하게 "이미 낸 걸로" 조용히 묻히는 일이 없다).
        const candidates = pool.get(dep.amount) || [];
        const nameMatches = dep.memo
          ? candidates.filter((c) => memoMatchesInst(dep, c))
          : [];

        if (nameMatches.length === 1) {
          const inst = nameMatches[0];
          removeFromPool(inst);
          matched.push({ deposit: dep, installment: inst });
          return;
        }

        if (nameMatches.length > 1) {
          // 같은 의뢰인의 같은 금액 회차가 여러 건이면(분할납부 회차별 금액이 동일한 경우 흔함),
          // 예정일이 이미 지난(연체) 회차가 있는지부터 본다 — 실무상 밀린 회차를 뒤늦게 낼 때가
          // 많은데, 그 경우 입금월이 밀린 회차의 예정월과는 다르고 오히려 "다음" 회차의 예정월과
          // 우연히 같아지는 경우가 있다(예: 7/26 예정 2회차를 8/10에 냈는데 3회차 예정일이
          // 8/26이라 입금월=예정월이 3회차 쪽만 맞는 경우). 이때 예정월이 같다는 이유만으로
          // 아직 예정일이 안 된 다음 회차를 매칭해버리면 정작 연체된 회차는 계속 미납으로 남는다.
          // → 연체 회차(예정일 ≤ 입금일)가 정확히 하나면 그걸 최우선으로 확정한다.
          const overdue = nameMatches
            .filter((c) => c.due_date && c.due_date <= dep.date)
            .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));

          if (overdue.length === 1) {
            const inst = overdue[0];
            removeFromPool(inst);
            matched.push({ deposit: dep, installment: inst });
            return;
          }

          if (overdue.length === 0) {
            // 연체 회차가 하나도 없으면(전부 예정일이 아직 안 지남) 입금일과 예정일이 같은
            // 달(yyyy-mm)인 회차로 좁혀본다 — 분할납부는 보통 한 달에 한 회차씩 내므로 입금 월과
            // 예정월이 거의 항상 일치한다.
            const depMonth = dep.date.slice(0, 7);
            const sameMonth = nameMatches.filter((c) => (c.due_date || '').slice(0, 7) === depMonth);
            if (sameMonth.length === 1) {
              const inst = sameMonth[0];
              removeFromPool(inst);
              matched.push({ deposit: dep, installment: inst });
              return;
            }
          }

          // 그래도 하나로 안 좁혀지면(연체 회차가 2건 이상이거나, 연체는 없는데 같은 달 후보도
          // 여러 건) 사람이 고르되, 과거 예정일(연체) 순으로 정렬해서 후보 목록 맨 위에 가장
          // 유력한(가장 오래 밀린) 회차가 오도록 한다.
          const sorted = nameMatches.slice().sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
          review.push({
            deposit: dep, candidates: sorted,
            reason: overdue.length > 1
              ? '연체된 회차가 여러 건입니다 (예정일이 빠른 순으로 정렬됨)'
              : '같은 이름·금액의 회차가 여러 건입니다 (예정일이 빠른 순으로 정렬됨)',
          });
          return;
        }

        // 2) 정확히 같은 금액의 미납 회차가 없는 경우 - 여러 회차를 한 번에 몰아서 낸 건 아닌지
        //    확인한다. 그 사람의 미납 회차를 예정일이 빠른 순서대로 누적 합산해서 입금액과
        //    "정확히" 같아지는 지점이 있으면(2건 이상) 그 구간 전체를 한 번에 확정한다.
        //    금액이 소수점 하나 없이 정확히 맞아떨어질 때만 적용해서 오매칭 위험을 없앤다.
        if (dep.memo) {
          let comboName = null;
          for (const [name, list] of byName.entries()) {
            if (name && dep.memo.startsWith(name.trim())) { comboName = name; break; }
            if (list.some((inst) => inst.payer_name && dep.memo.startsWith(inst.payer_name.trim()))) { comboName = name; break; }
          }
          if (comboName) {
            const list = byName.get(comboName) || [];
            let sum = 0;
            const group = [];
            for (const inst of list) {
              sum += inst.amount;
              group.push(inst);
              if (sum >= dep.amount) break;
            }
            if (sum === dep.amount && group.length >= 2) {
              group.forEach((inst) => {
                removeFromPool(inst);
                matched.push({ deposit: dep, installment: inst, combo: true, comboCount: group.length });
              });
              return;
            }
          }
        }

        // 3) 위 어느 것도 아니면, 이 입금이 이미 완료 처리된 회차에 대한 것일 수 있다(예전에
        //    수동/통장매칭으로 이미 확정된 건). 같은 이름·금액의 완료 회차가 남아있으면 하나
        //    소모하고 조용히 건너뛴다 - 매번 소모해야 같은 이름·금액의 서로 다른 입금 건이
        //    전부 "이미 처리됨"으로 뭉뚱그려지지 않는다.
        const paidCandidates = paidPool.get(dep.amount) || [];
        const paidNameMatches = dep.memo
          ? paidCandidates.filter((c) => memoMatchesInst(dep, c))
          : [];
        if (paidNameMatches.length > 0) {
          const claimed = paidNameMatches[0];
          paidCandidates.splice(paidCandidates.indexOf(claimed), 1);
          alreadyHandledCount++;
          return;
        }

        if (candidates.length > 0) {
          // candidates는 pool에 남아있는 실제 배열이라, 뒤에서 다른 입금이 매칭돼 splice로
          // 제거되면 이미 review에 넣어둔 이 항목까지 같이 바뀌어버린다 - 복사본을 넣어야 한다.
          review.push({ deposit: dep, candidates: candidates.slice(), reason: '금액은 일치하지만 입금자명이 다릅니다' });
        } else {
          unmatched.push(dep);
        }
      });

    const toCandidate = (c) => ({
      installment_id: c.id, case_id: c.case_id, client_name: c.client_name,
      seq: c.seq, amount: c.amount, due_date: c.due_date,
    });

    res.json({
      matched: matched.map((m) => ({
        deposit: m.deposit, ...toCandidate(m.installment),
        combo: !!m.combo, comboCount: m.comboCount || 1,
      })),
      review: review.map((r) => ({ deposit: r.deposit, reason: r.reason, candidates: r.candidates.map(toCandidate) })),
      unmatched,
      alreadyHandledCount,
      ignoredCount,
    });
  });
});

// 특정 입금 건을 "사건과 무관함(상담료 등)"으로 표시한다. 사건에 붙일 회차가 없는 입금(상담만
// 받고 의뢰하지 않은 사람의 상담료 등)을 통장내역 재분석 때마다 미매칭 목록에 다시 띄우지
// 않기 위한 용도 — 거래내역 자체를 지우지 않고 "이미 확인했다"는 표시만 남긴다(원칙 11).
app.post('/api/admin/fee-calendar/ignore-deposit', requireTab('fee'), (req, res) => {
  const date = String(req.body.date || '').slice(0, 10);
  const amount = Number(req.body.amount) || 0;
  const memo = String(req.body.memo || '').trim();
  const reason = String(req.body.reason || '').trim() || '상담료 등 (사건과 무관)';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || amount <= 0) {
    return res.status(400).json({ error: '입금 날짜와 금액이 올바르지 않습니다.' });
  }
  const info = db.prepare(
    `INSERT INTO fee_calendar_ignored_deposits (deposit_date, amount, memo, reason) VALUES (?, ?, ?, ?)`
  ).run(date, amount, memo, reason);
  res.json({ id: info.lastInsertRowid, deposit_date: date, amount, memo, reason });
});

// "사건과 무관함(상담료 등)"으로 표시해둔 입금 전체 목록을 보여준다 — 통장매칭 화면에서
// 표시만 하고 넘어가면 그 뒤로는 확인할 곳이 없었으므로, 나중에 다시 훑어보거나 실수로
// 표시한 걸 찾아 취소할 수 있도록 최근 순으로 전체를 조회할 수 있게 한다.
app.get('/api/admin/fee-calendar/ignored-deposits', requireTab('fee'), (req, res) => {
  const rows = db.prepare(
    `SELECT id, deposit_date, amount, memo, reason, created_at
     FROM fee_calendar_ignored_deposits ORDER BY created_at DESC, id DESC`
  ).all();
  res.json(rows);
});

// 위 표시를 취소한다 (실수로 눌렀을 때 되돌리기 용도).
app.delete('/api/admin/fee-calendar/ignore-deposit/:id', requireTab('fee'), (req, res) => {
  const info = db.prepare('DELETE FROM fee_calendar_ignored_deposits WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: '이미 삭제된 항목입니다.' });
  res.json({ deleted: true });
});

// 자동/확인필요 후보 목록에 원하는 회차가 없을 때, 사람이 의뢰인을 직접 검색해서 골라 그
// 사건에 새 납부 회차를 바로 "완료" 상태로 만든다. 회차를 미리 등록해두지 않은 사건에도
// 입금을 기록할 수 있다 — seq는 그 사건의 기존 회차 중 가장 큰 번호 다음으로 자동 부여한다.
app.post('/api/admin/fee-calendar/manual-deposit', requireTab('fee'), (req, res) => {
  const caseRow = db.prepare('SELECT id, client_name FROM cases WHERE id = ?').get(req.body.case_id);
  if (!caseRow) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  const date = String(req.body.date || '').slice(0, 10);
  const amount = Number(req.body.amount) || 0;
  const memo = String(req.body.memo || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || amount <= 0) {
    return res.status(400).json({ error: '입금 날짜와 금액이 올바르지 않습니다.' });
  }

  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM case_fee_installments WHERE case_id = ?').get(caseRow.id).m;
  const info = db.prepare(`
    INSERT INTO case_fee_installments (case_id, seq, amount, due_date, status, paid_date, memo, payment_method, payer_name, match_source)
    VALUES (?, ?, ?, ?, '완료', ?, ?, '계좌이체', ?, '수동')
  `).run(caseRow.id, maxSeq + 1, amount, date, date, '통장매칭 수동 등록', memo);

  const installment = db.prepare('SELECT * FROM case_fee_installments WHERE id = ?').get(info.lastInsertRowid);
  res.json({ installment, client_name: caseRow.client_name });
});

app.post('/api/admin/fee-calendar/confirm-matches', requireTab('fee'), (req, res) => {
  const { matches } = req.body || {};
  if (!Array.isArray(matches) || matches.length === 0) {
    return res.status(400).json({ error: '확정할 매칭 항목이 없습니다.' });
  }
  let confirmed = 0;
  const skipped = [];
  matches.forEach((m) => {
    const inst = db.prepare('SELECT * FROM case_fee_installments WHERE id = ?').get(m.installment_id);
    // 이미 완료 처리된 회차는 건너뛴다 (같은 미리보기를 실수로 두 번 확정하는 것을 막는 안전장치).
    if (!inst || inst.status === '완료') { skipped.push(m.installment_id); return; }
    const paidDate = String(m.paid_date || '').slice(0, 10) || inst.due_date;
    const memo = [inst.memo, '통장매칭 자동확인'].filter(Boolean).join(' / ');
    // 은행 입금 내역으로 매칭되는 건은 항상 계좌이체이고, 통장 내역의 입금자 표시(m.memo)가
    // 곧 입금자명이다 — 별도로 다시 물어볼 필요 없이 그대로 구조화된 필드에 채운다(OSMU).
    const payerName = String(m.memo || '').trim();
    db.prepare(`UPDATE case_fee_installments SET status='완료', paid_date=?, memo=?, payment_method='계좌이체', payer_name=?, match_source='자동', updated_at=datetime('now') WHERE id = ?`)
      .run(paidDate, memo, payerName, inst.id);
    confirmed++;
  });
  res.json({ confirmed, skipped });
});

// 이름 목록을 받아서 각 의뢰인의 미납(완료가 아닌) 회차를 한 번에 "수동 완납" 처리한다.
// 통장매칭 없이 사무실에서 직접 확인하고 일괄로 완납 처리해야 할 때(예: 현금 수납 확인 후
// 한꺼번에 정리) 쓰는 관리자 전용 기능. 동명이인이 있으면 어떤 사건인지 알 수 없으므로 절대
// 추측해서 처리하지 않고 ambiguous로 분류해 사람이 직접 확인하게 한다(데이터를 잃지 않는다).
app.post('/api/admin/fee-calendar/bulk-complete', requireTab('fee'), (req, res) => {
  const names = Array.isArray(req.body.names)
    ? Array.from(new Set(req.body.names.map((n) => String(n || '').trim()).filter(Boolean)))
    : [];
  if (!names.length) return res.status(400).json({ error: '이름 목록이 필요합니다.' });

  const today = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const todayStr = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

  const completed = [];
  const ambiguous = [];
  const notFound = [];
  const alreadyPaid = [];

  const updateStmt = db.prepare(
    `UPDATE case_fee_installments SET status='완료', paid_date=?, match_source='수동', updated_at=datetime('now') WHERE id = ?`
  );

  names.forEach((name) => {
    const cases = db.prepare('SELECT id, client_name, phone FROM cases WHERE client_name = ?').all(name);
    if (cases.length === 0) { notFound.push(name); return; }
    if (cases.length > 1) {
      ambiguous.push({ name, cases: cases.map((c) => ({ case_id: c.id, phone: c.phone })) });
      return;
    }
    const caseId = cases[0].id;
    const unpaid = db.prepare("SELECT * FROM case_fee_installments WHERE case_id = ? AND status != '완료'").all(caseId);
    if (unpaid.length === 0) { alreadyPaid.push(name); return; }
    unpaid.forEach((inst) => updateStmt.run(todayStr, inst.id));
    completed.push({
      name,
      case_id: caseId,
      count: unpaid.length,
      totalAmount: unpaid.reduce((sum, i) => sum + i.amount, 0),
    });
  });

  res.json({ paidDate: todayStr, completed, ambiguous, notFound, alreadyPaid });
});

/* ---- /api/case-tasks (사건별 서류/보정 일정) ---- */

// '연기'는 "보정연기" 기능(POST /api/case-tasks/:id/postpone)이 원래 건의 상태를 바꿔둘 때만 쓴다 -
// 새로 만들어지는 건은 그대로 '예정'으로 시작한다.
const CASE_TASK_STATUSES = ['예정', '진행중', '완료', '연기'];

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
  const { status, caseId, start, end } = req.query;
  // start/end: 팀 스케줄 달력(app.html)이 보이는 기간만 요청할 때 쓰는 선택적 필터.
  // /api/schedules와 마찬가지로 yyyy-mm-dd 앞 10자리만 비교해 due_date(날짜만 있음)와 맞춘다.
  const start10 = start ? String(start).slice(0, 10) : null;
  const end10 = end ? String(end).slice(0, 10) : null;
  const inRange = (r) => (!start10 || r.due_date >= start10) && (!end10 || r.due_date < end10);

  // 구글시트가 [일정_보정관리]의 원본으로 연동되어 있으면 시트를 실시간으로 읽어 보여준다
  // (직원이 시트에 입력한 내용이 그대로 반영됨). 연동 안 되어 있거나 읽기 실패 시 SQLite로 폴백.
  try {
    const sheetTasks = await readTasksFromSheetIfConnected();
    if (sheetTasks) {
      let rows = sheetTasks;
      if (status) rows = rows.filter((r) => r.status === status);
      if (caseId) rows = rows.filter((r) => String(r.case_id) === String(caseId));
      if (start10 || end10) rows = rows.filter(inRange);
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
  if (start10) { conditions.push('due_date >= ?'); params.push(start10); }
  if (end10) { conditions.push('due_date < ?'); params.push(end10); }
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

  // 직원 계정은 새로 올리는 서류/보정일정의 담당자가 항상 본인 이름으로 고정된다 - 프론트엔드에서
  // 드롭다운을 잠가둔 것과 별개로, 여기서도 강제해야 API를 직접 호출해서 남의 이름으로 등록하는
  // 것을 막을 수 있다. 관리자만 담당자를 자유롭게 지정할 수 있다.
  const resolvedAssignee = req.user.role === 'admin' ? (assignee_name || caseRow.assignee_name || '') : req.user.name;

  const safeStatus = CASE_TASK_STATUSES.includes(status) ? status : '예정';
  const info = db
    .prepare(`INSERT INTO case_tasks (case_id, task_type, received_date, due_date, status, assignee_name, memo, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(case_id, task_type, received_date || '', due_date, safeStatus, resolvedAssignee, memo || '', req.user.id);

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

/* ---- /api/case-notes (사건별 메모 누적 기록 - append-only, 수정/삭제 API 없음) ---- */

app.get('/api/case-notes', requireLogin, (req, res) => {
  const caseId = req.query.caseId;
  if (!caseId) return res.status(400).json({ error: 'caseId가 필요합니다.' });
  const notes = db
    .prepare(`SELECT n.*, e.name AS author_name FROM case_notes n
              LEFT JOIN employees e ON e.id = n.created_by
              WHERE n.case_id = ? ORDER BY n.id DESC`)
    .all(caseId);
  res.json(notes);
});

app.post('/api/case-notes', requireLogin, (req, res) => {
  const { case_id, content } = req.body || {};
  if (!case_id || !content || !content.trim()) return res.status(400).json({ error: '사건과 메모 내용은 필수입니다.' });

  const caseRow = db.prepare('SELECT id, client_name FROM cases WHERE id = ?').get(case_id);
  if (!caseRow) return res.status(404).json({ error: '사건을 찾을 수 없습니다.' });

  const info = db
    .prepare('INSERT INTO case_notes (case_id, content, created_by) VALUES (?, ?, ?)')
    .run(case_id, content.trim(), req.user.id);
  const note = db
    .prepare(`SELECT n.*, e.name AS author_name FROM case_notes n
              LEFT JOIN employees e ON e.id = n.created_by WHERE n.id = ?`)
    .get(info.lastInsertRowid);
  res.status(201).json(note);

  // 메모 저장 알림(카톡): 응답은 이미 보냈으니 발송 실패가 메모 저장 자체를 막지 않는다 (fire-and-forget).
  notifyCaseNoteAdded(caseRow, note).catch((err) => console.error('[kakao] 메모 알림 발송 실패:', err.message));
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

// "보정연기": 보정서 제출 마감을 N일 뒤로 미룬다. 기존 건은 삭제/덮어쓰지 않고 상태만 '연기'로
// 바꿔 그대로 남겨둔다(몇 번 연기했는지 이력을 알 수 있어야 하므로 - 사용자 확정 사항). 대신
// 같은 내용(업무구분/수령일/담당자/메모)에 마감예정일만 새로 계산해서 새 건을 하나 더 만들고,
// 그 새 건이 이제부터 진짜 마감 예정 건이 된다.
app.post('/api/case-tasks/:id/postpone', requireLogin, async (req, res) => {
  if (String(req.params.id).startsWith('sheet-')) {
    return res.status(400).json({ error: '이 일정은 구글시트에서 관리됩니다. 시트에서 직접 관리해주세요.', code: 'SHEET_MANAGED' });
  }

  const task = db.prepare('SELECT * FROM case_tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: '일정을 찾을 수 없습니다.' });
  if (task.task_type !== '보정서 제출') {
    return res.status(400).json({ error: '보정연기는 "보정서 제출" 업무에만 사용할 수 있습니다.' });
  }
  if (task.status !== '예정') {
    return res.status(400).json({ error: '이미 처리(연기/진행중/완료)된 일정은 다시 연기할 수 없습니다.' });
  }

  const days = Number(req.body && req.body.days);
  if (!Number.isInteger(days) || days <= 0) {
    return res.status(400).json({ error: '연기 일수는 1 이상의 정수여야 합니다.' });
  }

  db.prepare(`UPDATE case_tasks SET status = '연기', updated_at = datetime('now') WHERE id = ?`).run(task.id);

  const newDueDate = addDaysToDateString(task.due_date, days);
  const info = db
    .prepare(`INSERT INTO case_tasks (case_id, task_type, received_date, due_date, status, assignee_name, memo, created_by)
              VALUES (?, ?, ?, ?, '예정', ?, ?, ?)`)
    .run(task.case_id, task.task_type, task.received_date || '', newDueDate, task.assignee_name || '', task.memo || '', req.user.id);

  const newTask = db.prepare('SELECT * FROM case_tasks WHERE id = ?').get(info.lastInsertRowid);

  try {
    const googleEventId = await googleCreateEvent(caseTaskToGoogleEvent(newTask));
    if (googleEventId) {
      db.prepare('UPDATE case_tasks SET google_event_id = ? WHERE id = ?').run(googleEventId, newTask.id);
      newTask.google_event_id = googleEventId;
    }
  } catch (err) { console.error('구글 캘린더 등록 실패(보정연기):', err.message); }

  const oldTask = db.prepare('SELECT * FROM case_tasks WHERE id = ?').get(task.id);
  res.status(201).json({ oldTask: caseTaskWithCase(oldTask), newTask: caseTaskWithCase(newTask) });
});

/* ---- /api/sheets (사건목록 내보내기 + 일정_보정관리 구글시트 연동 상태) ---- */

/* ---- /api/settings (담당직원/담당변호사 기본값 등 앱 전역 기본값) ---- */

app.get('/api/settings/defaults', requireLogin, (req, res) => {
  const s = getAppSettings();
  res.json({
    default_assignee_name: (s && s.default_assignee_name) || '',
    default_lawyer_name: (s && s.default_lawyer_name) || '',
  });
});

app.patch('/api/settings/defaults', requireAdmin, (req, res) => {
  const existing = getAppSettings();
  const { default_assignee_name, default_lawyer_name } = req.body || {};
  const updated = {
    default_assignee_name: default_assignee_name != null ? String(default_assignee_name).trim() : existing.default_assignee_name,
    default_lawyer_name: default_lawyer_name != null ? String(default_lawyer_name).trim() : existing.default_lawyer_name,
  };
  db.prepare(
    `UPDATE app_settings SET default_assignee_name = ?, default_lawyer_name = ?, updated_at = datetime('now') WHERE id = 1`
  ).run(updated.default_assignee_name, updated.default_lawyer_name);
  res.json(getAppSettings());
});

// 보정 업무(서류/일정) 원본을 구글시트 -> 앱(SQLite)으로 전환한다.
// 시트에 남아있던 미완료/완료 일정을 모두 case_tasks로 옮기고, 이후로는 앱에서
// 생성/수정/완료 처리가 전부 즉시 반영된다. 시트 자체는 건드리지 않는다(참고용으로 남음).
app.post('/api/admin/tasks-source/switch-to-app', requireAdmin, async (req, res) => {
  try {
    const result = await migrateSheetTasksToApp(req.user.id);
    res.json(result);
  } catch (err) {
    console.error('보정 업무 앱 전환 실패:', err.message);
    res.status(500).json({ error: '전환 중 오류가 발생했습니다: ' + err.message });
  }
});

// ---- 수임료 납부일정 시트 → 앱 이식(migration) 전용 유틸리티 (일회성) ----
// "법진 수임료 관리" 구글시트 구조:
//   A=순번, B=이름, C=전화번호, D=수임일자, E=수임료(총액)
//   F~ : 1~4회차는 각 8칸(예정납부일/예정납부금액/실제납부일/실제납부액/납부여부/문자발송여부/문자발송날짜/결제방식),
//        5회차만 5칸(예정납부일/예정납부금액/실제납부일/실제납부액/문자발송날짜 — 납부여부/문자발송여부/결제방식 없음)
//   마지막 열 = 완납여부(전체 요약, 회차 데이터 아님)
const FEE_MIGRATION_SPREADSHEET_ID = '1b5ox11BcCbnrjZQjRNx6RcWz6hMJQUN1nec3VuYKnDQ';

// 시트의 날짜는 "2024-10- 21" / "2024. 10. 21" / "2025. 1. 5" 등 표기가 제각각이라
// 숫자 3덩어리(년/월/일)만 뽑아 yyyy-mm-dd로 통일한다.
function parseFeeSheetDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const m = s.match(/(\d{4})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})/);
  if (!m) return '';
  const [, y, mo, d] = m;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// "₩500,000" / "500000" 등을 숫자(원)로 통일한다.
function parseFeeSheetAmount(raw) {
  const s = String(raw == null ? '' : raw).replace(/[₩,\s]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// 시트 원본 rows(헤더 2줄 포함)를 의뢰인별 구조로 파싱한다.
function parseFeeSheetRows(rows) {
  const clients = [];
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r] || [];
    const name = String(row[1] || '').trim();
    if (!name) continue;

    const client = {
      sheetRow: r + 1,
      name,
      phone: String(row[2] || '').trim(),
      engagementDateRaw: row[3] || '',
      engagementDate: parseFeeSheetDate(row[3]),
      totalFee: parseFeeSheetAmount(row[4]),
      fullyPaidFlag: String(row[42] || '').includes('완납'),
      installments: [],
    };

    for (let i = 0; i < 5; i++) {
      const base = i < 4 ? 5 + i * 8 : 37;
      const due = parseFeeSheetDate(row[base]);
      const amount = parseFeeSheetAmount(row[base + 1]);
      const paidDate = parseFeeSheetDate(row[base + 2]);
      const paidAmount = parseFeeSheetAmount(row[base + 3]);
      let paidFlagRaw = '';
      let method = '';
      if (i < 4) {
        paidFlagRaw = String(row[base + 4] || '');
        method = String(row[base + 7] || '').trim();
      }
      if (!due && !amount && !paidDate && !paidAmount) continue; // 이 회차는 데이터 없음(건너뜀)

      const isPaid = i < 4 ? paidFlagRaw.includes('납부') : !!(paidDate || paidAmount);
      client.installments.push({
        seq: i + 1,
        due_date: due,
        amount: amount || paidAmount,
        status: isPaid ? '완료' : '예정',
        paid_date: isPaid ? (paidDate || due) : '',
        memo: method ? `결제방식: ${method}` : '',
      });
    }

    clients.push(client);
  }
  return clients;
}

// 실제로 아무것도 쓰지 않고, 시트를 파싱해서 "앱에 이식하면 어떻게 되는지" 요약만 보여준다.
// (사건과 이름이 매칭되는 의뢰인 수, 매칭 안 되는 이름 목록, 회차 개수/기납부·예정 개수 등)
app.get('/api/admin/fee-migration-preview', requireAdmin, async (req, res) => {
  try {
    const client = await getSheetsAuthorizedClient();
    if (!client) return res.status(400).json({ error: '구글 계정이 연동되어 있지 않습니다.' });
    const sheets = google.sheets({ version: 'v4', auth: client });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: FEE_MIGRATION_SPREADSHEET_ID,
      range: 'A1:AR200',
    });
    const rows = result.data.values || [];
    const clients = parseFeeSheetRows(rows);

    // 매칭은 앱 SQLite cases가 아니라 "의뢰인 명단"(법진 사건관리 시트, 연동돼 있으면 그쪽이 진짜 원본)
    // 기준으로 한다 - /api/clients/open-case와 동일한 방식. 앱에는 아직 사건으로 "열어보지" 않은
    // 의뢰인이 많을 뿐, 실제로는 의뢰인 명단에 이미 다 있는 경우가 대부분이기 때문.
    const rosterCandidates = await getMatchCandidates();
    const existingCases = db.prepare('SELECT * FROM cases').all().map((c) => Object.assign({ _sortKey: c.id }, c));

    const inRosterWithCase = []; // 의뢰인 명단에도 있고, 앱에 사건도 이미 만들어져 있음
    const inRosterNoCase = []; // 의뢰인 명단에는 있는데, 앱에는 아직 사건이 안 만들어짐 (자동 생성 필요)
    const notInRoster = []; // 의뢰인 명단에서도 못 찾은 이름 (시트 표기 차이 등 확인 필요)
    let totalInstallments = 0;
    let paidCount = 0;
    let upcomingCount = 0;
    let dateParseFailures = 0;

    clients.forEach((c) => {
      const rosterMatch = matchCaseByNameAndCaseNo(rosterCandidates, c.name, '');
      const caseMatch = matchCaseByNameAndCaseNo(existingCases, c.name, '');
      if (caseMatch) {
        inRosterWithCase.push({ name: c.name, caseId: caseMatch.id });
      } else if (rosterMatch) {
        inRosterNoCase.push({ name: c.name, court: rosterMatch.court || '', court_case_no: rosterMatch.court_case_no || '' });
      } else {
        notInRoster.push(c.name);
      }
      if (c.engagementDateRaw && !c.engagementDate) dateParseFailures++;
      c.installments.forEach((ins) => {
        totalInstallments++;
        if (ins.status === '완료') paidCount++; else upcomingCount++;
      });
    });

    // 특정 의뢰인 이름을 지정하면(?debugNames=이름1,이름2) 시트에서 그 사람 행이 실제로
    // 어떻게 파싱됐는지 그대로 보여준다 - "왜 이 사람만 회차가 하나도 안 들어갔지?" 같은
    // 문의가 들어왔을 때, 시트 원본 데이터 자체를 다시 안 열어봐도 바로 원인을 확인하기 위함.
    const debugNames = String(req.query.debugNames || '').split(',').map((s) => s.trim()).filter(Boolean);
    const debug = debugNames.length ? clients.filter((c) => debugNames.includes(c.name)) : undefined;

    res.json({
      totalClients: clients.length,
      rosterConnected: !!(getStoredGoogleAuth() && getStoredGoogleAuth().clients_sheet_tab),
      alreadyHasCaseCount: inRosterWithCase.length,
      willAutoCreateCount: inRosterNoCase.length,
      notInRosterCount: notInRoster.length,
      notInRosterNames: notInRoster,
      willAutoCreateSample: inRosterNoCase.slice(0, 10),
      totalInstallments,
      paidCount,
      upcomingCount,
      dateParseFailures,
      sample: clients.slice(0, 3),
      debug,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 실제로 이식을 실행한다 (진홍 님 확인 후 1회성으로 사용).
// - 사건이 없는 의뢰인은 의뢰인 명단(이름/전화/법원/사건번호)으로 사건을 자동 생성한다.
// - 회차는 예정/완료 모두 이식한다 — 과거에 이미 완납된 회차도 문서/이력 자산이므로 함께 옮긴다
//   (이전 버전은 완료된 회차를 건너뛰어, 시트상 완납 처리된 의뢰인은 앱에 회차 이력이 전혀 없는 상태가 되는
//   문제가 있었음 — 완납된 회차도 반드시 이식하도록 수정함).
// - 결제방식은 메모에 "결제방식: OOO"로 같이 적는다.
// - 다시 실행해도 안전하도록(idempotent), 이미 그 case_id + seq 조합의 회차가 있으면 건드리지 않고 건너뛴다.
app.post('/api/admin/fee-migration-run', requireAdmin, async (req, res) => {
  try {
    const client = await getSheetsAuthorizedClient();
    if (!client) return res.status(400).json({ error: '구글 계정이 연동되어 있지 않습니다.' });
    const sheets = google.sheets({ version: 'v4', auth: client });
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: FEE_MIGRATION_SPREADSHEET_ID,
      range: 'A1:AR200',
    });
    const rows = result.data.values || [];
    let sheetClients = parseFeeSheetRows(rows);
    const limit = parseInt(req.query.limit, 10);
    if (Number.isFinite(limit) && limit > 0) sheetClients = sheetClients.slice(0, limit);

    const rosterCandidates = await getMatchCandidates();

    let casesCreated = 0;
    let installmentsInserted = 0;
    let installmentsInsertedPaid = 0;
    let installmentsInsertedUpcoming = 0;
    let installmentsSkippedExisting = 0;
    const problems = [];

    sheetClients.forEach((c) => {
      // 매번 최신 사건 목록으로 다시 매칭 (직전 클라이언트 처리에서 방금 만든 사건도 반영되도록)
      const existingCases = db.prepare('SELECT * FROM cases').all().map((r) => Object.assign({ _sortKey: r.id }, r));
      let matchedCase = matchCaseByNameAndCaseNo(existingCases, c.name, '');

      if (!matchedCase) {
        const rosterMatch = matchCaseByNameAndCaseNo(rosterCandidates, c.name, '');
        if (!rosterMatch) {
          problems.push(`${c.name}: 의뢰인 명단에서도 찾을 수 없어 건너뜀`);
          return;
        }
        const info = db
          .prepare(`INSERT INTO cases (client_name, phone, court, court_case_no, assignee_name, memo, case_type, intake_date, assigned_lawyer, current_stage, status, created_by, updated_at)
                    VALUES (?, ?, ?, ?, '', '', '', ?, '', '', '사건진행중', ?, datetime('now'))`)
          .run(c.name, rosterMatch.phone || '', rosterMatch.court || '', rosterMatch.court_case_no || '', c.engagementDate || '', req.user.id);
        matchedCase = { id: info.lastInsertRowid };
        casesCreated++;
      }

      // 수임료 총액: 이 사건에 아직 case_fees가 없을 때만 시트 값으로 채운다 (기존 수기 입력을 덮어쓰지 않음).
      const hasFee = db.prepare('SELECT case_id FROM case_fees WHERE case_id = ?').get(matchedCase.id);
      if (!hasFee && c.totalFee) {
        db.prepare(`INSERT INTO case_fees (case_id, total_amount, memo, updated_at) VALUES (?, ?, '', datetime('now'))`)
          .run(matchedCase.id, c.totalFee);
      }

      c.installments.forEach((ins) => {
        const already = db.prepare('SELECT id FROM case_fee_installments WHERE case_id = ? AND seq = ?').get(matchedCase.id, ins.seq);
        if (already) { installmentsSkippedExisting++; return; }

        db.prepare(`
          INSERT INTO case_fee_installments (case_id, seq, amount, due_date, status, paid_date, memo)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(matchedCase.id, ins.seq, ins.amount, ins.due_date, ins.status, ins.paid_date, ins.memo);
        installmentsInserted++;
        if (ins.status === '완료') installmentsInsertedPaid++; else installmentsInsertedUpcoming++;
      });
    });

    res.json({
      casesCreated,
      installmentsInserted,
      installmentsInsertedPaid,
      installmentsInsertedUpcoming,
      installmentsSkippedExisting,
      problems,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// (일회성) 의뢰인목록 정렬용 수임일자(retainer_date) 이식.
// "수임료 관리" 시트 D열(수임일자)을 이름으로 매칭해서 cases.retainer_date에 채워 넣는다.
// 다시 실행해도 안전하다(매번 시트 값으로 덮어씀 - 시트가 원본이므로).
app.post('/api/admin/retainer-date-migration-run', requireAdmin, async (req, res) => {
  try {
    const client = await getSheetsAuthorizedClient();
    if (!client) return res.status(400).json({ error: '구글 계정이 연동되어 있지 않습니다.' });
    const sheets = google.sheets({ version: 'v4', auth: client });
    const result = await sheets.spreadsheets.values.get({ spreadsheetId: FEE_MIGRATION_SPREADSHEET_ID, range: 'A1:AR200' });
    const rows = result.data.values || [];
    const sheetClients = parseFeeSheetRows(rows);

    let matched = 0;
    let noDate = 0;
    const notFound = [];

    sheetClients.forEach((c) => {
      if (!c.engagementDate) { noDate++; return; }
      // 매번 최신 사건 목록으로 매칭 (이름 중복 시 court_case_no까지 봐야 하므로).
      const existingCases = db.prepare('SELECT * FROM cases').all().map((r) => Object.assign({ _sortKey: r.id }, r));
      const matchedCase = matchCaseByNameAndCaseNo(existingCases, c.name, '');
      if (!matchedCase) { notFound.push(c.name); return; }
      db.prepare('UPDATE cases SET retainer_date = ? WHERE id = ?').run(c.engagementDate, matchedCase.id);
      matched++;
    });

    res.json({ totalInSheet: sheetClients.length, matched, noDate, notFoundCount: notFound.length, notFound });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// (일회성) 의뢰인목록 고정 순서(client_rank) 이식.
// retainer_date 기반 정렬은 시트 표기가 제각각이라 "뒤죽박죽"으로 보이는 문제가 있어,
// 대신 관리자가 직접 지정한 순서(names 배열, 앞에 올수록 나중 순위)를 그대로 고정 순번으로 저장한다.
// - body.names: 옛날→최근 순으로 나열된 이름 배열. 배열 앞쪽(옛날)일수록 낮은 client_rank,
//   뒤쪽(최근)일수록 높은 client_rank를 받는다 → 정렬은 client_rank DESC이므로 배열 순서의
//   "역순"으로 화면에 표시된다 (요청하신 그대로).
// - 이름이 여러 사건과 겹치면(동명이인) 아직 순번이 없는 사건 중 id가 가장 작은 것부터 배정한다.
// - names 목록에 없는 기존 사건(예: 시트 이후 새로 계약 전환된 의뢰인)은 이미 client_rank가 있으면
//   건드리지 않고, 없으면 목록 전체보다 높은 순번을 부여해 맨 위로 올라오게 한다 — "새로 추가되는
//   사람은 위에 계속 쌓인다"는 요청사항을 이미 있던 미분류 의뢰인에게도 동일하게 적용.
// - 다시 실행해도 안전하다: 이름 목록에 있는 사건은 매번 같은 값으로 재기록되고, 이미 순번이 있는
//   사건은 두 번째 단계에서 건드리지 않는다.
app.post('/api/admin/client-rank-run', requireAdmin, (req, res) => {
  try {
    const names = Array.isArray(req.body && req.body.names) ? req.body.names.map((s) => String(s).trim()).filter(Boolean) : [];
    if (!names.length) return res.status(400).json({ error: 'names 배열이 필요합니다.' });

    const assignedCaseIds = new Set();
    const notFound = [];
    let matched = 0;

    names.forEach((name, idx) => {
      const rank = idx + 1;
      const candidates = db.prepare('SELECT id FROM cases WHERE client_name = ? ORDER BY id ASC').all(name)
        .filter((c) => !assignedCaseIds.has(c.id));
      if (!candidates.length) { notFound.push(name); return; }
      const target = candidates[0];
      db.prepare('UPDATE cases SET client_rank = ? WHERE id = ?').run(rank, target.id);
      assignedCaseIds.add(target.id);
      matched++;
    });

    // names 목록 밖에 있던 기존 사건 중 아직 순번이 없는 것들은, 예전 정렬 기준(retainer_date/updated_at)
    // 순서를 그대로 유지한 채 목록 전체보다 높은 순번을 매겨 맨 위로 올린다.
    // leftover[0]가 예전 기준으로 "가장 최근"이므로, client_rank DESC 정렬에서 맨 위에 오도록
    // 가장 큰 순번을 줘야 한다 — 즉 배열을 뒤에서부터(가장 오래된 것부터) 순번을 채워 나간다.
    const leftover = db.prepare(`
      SELECT id FROM cases WHERE client_rank IS NULL
      ORDER BY (retainer_date IS NULL OR retainer_date = '') DESC, retainer_date DESC, updated_at DESC, id DESC
    `).all();
    const backfilled = leftover.length;
    for (let i = leftover.length - 1; i >= 0; i--) {
      const rank = names.length + (leftover.length - i);
      db.prepare('UPDATE cases SET client_rank = ? WHERE id = ?').run(rank, leftover[i].id);
    }

    res.json({ totalNames: names.length, matched, notFoundCount: notFound.length, notFound, backfilled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 사건유형(개인회생/개인파산) 추정: 진홍 님 말씀대로 파산은 보통 5회차까지, 회생은 보통 4회차까지
// 납부받는다는 실무 규칙을 이용해, 시트의 회차 개수로 사건유형을 추측한다.
// "보통"이라는 표현대로 100% 확실한 규칙은 아니라서, 이미 사건유형이 채워진 사건은 절대 건드리지 않고
// 비어있는 사건에만 참고용으로 채워 넣는다 (실행 전 미리보기로 먼저 몇 건인지 확인 가능).
async function computeCaseTypeSuggestions() {
  const client = await getSheetsAuthorizedClient();
  if (!client) { const err = new Error('구글 계정이 연동되어 있지 않습니다.'); throw err; }
  const sheets = google.sheets({ version: 'v4', auth: client });
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: FEE_MIGRATION_SPREADSHEET_ID, range: 'A1:AR200' });
  const rows = result.data.values || [];
  const sheetClients = parseFeeSheetRows(rows);
  const existingCases = db.prepare('SELECT * FROM cases').all().map((r) => Object.assign({ _sortKey: r.id }, r));

  const suggestions = [];
  let alreadySetCount = 0;
  let noMatchCount = 0;

  sheetClients.forEach((c) => {
    const maxSeq = c.installments.reduce((m, ins) => Math.max(m, ins.seq), 0);
    if (!maxSeq) return;
    const matchedCase = matchCaseByNameAndCaseNo(existingCases, c.name, '');
    if (!matchedCase) { noMatchCount++; return; }
    if (matchedCase.case_type) { alreadySetCount++; return; }
    suggestions.push({
      caseId: matchedCase.id,
      name: c.name,
      maxSeq,
      suggestedType: maxSeq >= 5 ? '개인파산' : '개인회생',
    });
  });

  return { suggestions, alreadySetCount, noMatchCount };
}

app.get('/api/admin/case-type-suggestion-preview', requireAdmin, async (req, res) => {
  try {
    const { suggestions, alreadySetCount, noMatchCount } = await computeCaseTypeSuggestions();
    const seq5 = suggestions.filter((s) => s.suggestedType === '개인파산');
    const seq4OrLess = suggestions.filter((s) => s.suggestedType === '개인회생');
    res.json({
      totalSuggested: suggestions.length,
      alreadySetCount,
      noMatchCount,
      개인파산Count: seq5.length,
      개인회생Count: seq4OrLess.length,
      개인파산Sample: seq5.slice(0, 10).map((s) => s.name),
      개인회생Sample: seq4OrLess.slice(0, 10).map((s) => s.name),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/case-type-suggestion-run', requireAdmin, async (req, res) => {
  try {
    const { suggestions } = await computeCaseTypeSuggestions();
    let updated = 0;
    suggestions.forEach((s) => {
      // 재확인: 그 사이 다른 곳에서 이미 채워졌을 수 있으니 실행 시점에도 다시 빈 값인지 확인
      const fresh = db.prepare('SELECT case_type FROM cases WHERE id = ?').get(s.caseId);
      if (fresh && !fresh.case_type) {
        db.prepare('UPDATE cases SET case_type = ? WHERE id = ?').run(s.suggestedType, s.caseId);
        updated++;
      }
    });
    res.json({ updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// (2026-08: "의뢰인 시트 연결" 기능 자체를 제거했다. 의뢰인목록은 이제 SQLite cases만 본다.)

// 인감도장/공동인증서 USB 수령 여부는 앱 자체 SQLite에 보관.
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

// 상담관리(사건상세)에서 상태를 이 값들로 바꾸면 "계약된 의뢰인"으로 보고 의뢰인목록에 노출한다.
// case-detail.html의 #f-status 옵션(상담중/접수전/사건진행중/개시결정후)과 짝을 맞춘 목록.
// (2026-08: '접수전'도 수임계약이 체결된 상태라 계약된 의뢰인으로 보고 추가했다. 의뢰인목록에
//  나타나도 원본 사건 데이터는 cases 테이블 그대로이고 상담관리 목록에서도 계속 조회할 수 있다 -
//  "이동"이 아니라 상태 기준으로 같은 데이터를 두 화면에 함께 보여주는 것뿐이다.)
const CONTRACTED_CASE_STATUSES = ['접수전', '사건진행중', '개시결정후'];

// getClients() 역할: 자동완성/검색창에 쓸 의뢰인 목록을 돌려준다. 인감도장·USB 수령 여부도 같이 붙여서 준다.
// (2026-08: 의뢰인 명단 외부 구글시트는 더 이상 갱신되지 않아 완전히 폐기하고, 앱 SQLite의 cases
//  테이블 하나만을 단일 원본으로 사용한다 - "하나의 플랫폼 / SQLite 단일 데이터베이스" 원칙.
//  상담관리에서 상태를 "접수전"/"사건진행중"/"개시결정후"로 바꾸는 순간 여기 자동으로 나타난다.
//  정렬은 client_rank(숫자가 클수록 위) 역순 고정 - retainer_date는 시트 표기가 제각각이라
//  순서가 들쭉날쭉해지는 문제가 있어 더 이상 정렬 기준으로 쓰지 않는다. client_rank가 아직 없는
//  극히 예외적인 행만 이전 방식(retainer_date/updated_at)으로 보조 정렬한다.)
app.get('/api/clients', requireLogin, (req, res) => {
  try {
    const placeholders = CONTRACTED_CASE_STATUSES.map(() => '?').join(', ');
    const cases = db.prepare(`
      SELECT * FROM cases WHERE status IN (${placeholders})
      ORDER BY (client_rank IS NULL) ASC, client_rank DESC,
               (retainer_date IS NULL OR retainer_date = '') DESC, retainer_date DESC, updated_at DESC, id DESC
    `).all(...CONTRACTED_CASE_STATUSES);
    const clients = cases.map((c) => attachClientDocs({
      id: `case-${c.id}`,
      case_id: c.id,
      client_name: c.client_name,
      phone: c.phone || '',
      court: c.court || '',
      court_case_no: c.court_case_no || '',
      assignee_name: c.assignee_name || '',
      // 의뢰인목록에서 "현재 사건진행현황"을 바로 보여주고 그 자리에서 바로 바꿀 수 있게 하려면
      // 사건유형(case_type)도 같이 내려줘야 한다 - 유형별로 선택 가능한 단계 목록이 다르기 때문.
      case_type: c.case_type || '',
      current_stage: c.current_stage || '',
    }));
    res.json(clients);
  } catch (err) {
    console.error('의뢰인 목록 읽기 실패:', err.message);
    res.status(500).json({ error: '의뢰인 목록을 불러오지 못했습니다: ' + err.message });
  }
});

// (2026-08: 의뢰인 명단 외부 시트 → SQLite 1회성 이식은 완료되어 관련 임시 API를 제거했다.
//  이제 /api/clients는 위에서 보듯 cases 테이블만 본다.)

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

  // 의뢰인 시트(원본)에 이미 올라와 있는 사람은 계약이 성사된 정식 의뢰인이므로
  // status를 '사건진행중'으로 시작한다 (상담관리에서 새로 등록하는 경우와 구분).
  const info = db
    .prepare(`INSERT INTO cases (client_name, phone, court, court_case_no, assignee_name, memo, case_type, intake_date, assigned_lawyer, current_stage, status, created_by, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
    .run(client_name, phone || '', court || '', court_case_no || '', '', '', '', '', '', '', '사건진행중', req.user.id);
  res.status(201).json({ id: info.lastInsertRowid, created: true });
});

// addSchedule() 역할: 선택한 의뢰인 정보 + 할 일 + 마감일을 등록한다.
// tasks_source가 'sheet'이면 예전처럼 [일정_보정관리] 탭 맨 아래에 행을 추가하고,
// 'app'(전환 후, 기본값)이면 사건을 찾거나 새로 만든 뒤 case_tasks에 바로 저장한다.
// (의뢰인 자동완성은 이제 SQLite cases만 쓰므로 구글시트 연동 여부와 무관하게 항상 동작한다.)
app.post('/api/clients/schedule', requireLogin, async (req, res) => {
  const { client_name, court_case_no, task_type, due_date, received_date, assignee_name, memo } = req.body || {};
  if (!client_name || !task_type || !due_date) {
    return res.status(400).json({ error: '의뢰인, 업무구분, 마감예정일은 필수입니다.' });
  }

  const authRow = getStoredGoogleAuth();

  if (!authRow || authRow.tasks_source !== 'sheet') {
    // 앱(SQLite)이 원본: 사건을 찾거나 새로 만들고 case_tasks에 바로 저장한다.
    const cases = db.prepare('SELECT * FROM cases').all().map((c) => Object.assign({ _sortKey: c.id }, c));
    let matchedCase = matchCaseByNameAndCaseNo(cases, client_name, court_case_no);
    if (!matchedCase) {
      const info = db
        .prepare(`INSERT INTO cases (client_name, phone, court, court_case_no, assignee_name, memo, case_type, intake_date, assigned_lawyer, current_stage, status, created_by, updated_at)
                  VALUES (?, '', '', ?, ?, '', '', '', '', '', '사건진행중', ?, datetime('now'))`)
        .run(client_name, court_case_no || '', assignee_name || '', req.user.id);
      matchedCase = { id: info.lastInsertRowid };
    }

    const taskInfo = db
      .prepare(`INSERT INTO case_tasks (case_id, task_type, received_date, due_date, status, assignee_name, memo, created_by)
                VALUES (?, ?, ?, ?, '예정', ?, ?, ?)`)
      .run(matchedCase.id, task_type, received_date || '', due_date, assignee_name || (req.user && req.user.name) || '', memo || '', req.user.id);

    const task = db.prepare('SELECT * FROM case_tasks WHERE id = ?').get(taskInfo.lastInsertRowid);
    try {
      const googleEventId = await googleCreateEvent(caseTaskToGoogleEvent(task));
      if (googleEventId) db.prepare('UPDATE case_tasks SET google_event_id = ? WHERE id = ?').run(googleEventId, task.id);
    } catch (err) { console.error('구글 캘린더 등록 실패:', err.message); }

    return res.status(201).json({ ok: true, id: task.id });
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

/* ------------------------------------------------------------------ */
/* 팀 일정 카카오톡 알림 ("나에게 보내기")                                */
/*   - 의뢰인 대상 알림톡(솔라피)과는 완전히 별개의 기능이다.               */
/*   - 카카오 로그인 개인 API라 채널 심사가 필요 없고, label(계정)마다     */
/*     refresh_token을 하나씩 저장해서 등록된 계정 수만큼 각자의           */
/*     "나와의 채팅방"으로 발송한다.                                      */
/* ------------------------------------------------------------------ */

// 카카오 인가 URL에 실어 보내는 state를 서명한다 - 누구든 /kakao/callback을 직접 호출해서
// 아무 label로나 수신자를 등록해버리는 것을 막기 위함. 발급 후 10분 이내에만 유효하다.
function signKakaoLinkState(label) {
  const secret = process.env.KAKAO_LINK_SETUP_KEY || '';
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', secret).update(`${label}.${ts}`).digest('hex').slice(0, 32);
  return Buffer.from(`${label}.${ts}.${sig}`, 'utf8').toString('base64url');
}

function verifyKakaoLinkState(state) {
  try {
    const [label, ts, sig] = Buffer.from(String(state), 'base64url').toString('utf8').split('.');
    if (!label || !ts || !sig) return null;
    const secret = process.env.KAKAO_LINK_SETUP_KEY || '';
    const expected = crypto.createHmac('sha256', secret).update(`${label}.${ts}`).digest('hex').slice(0, 32);
    if (sig !== expected) return null;
    if (Date.now() - Number(ts) > 10 * 60 * 1000) return null; // 10분 초과 시 재사용 불가
    return label;
  } catch (err) {
    return null;
  }
}

async function exchangeKakaoAuthCode(code) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.KAKAO_REST_API_KEY || '',
    redirect_uri: process.env.KAKAO_REDIRECT_URI || '',
    code,
    client_secret: process.env.KAKAO_CLIENT_SECRET || '',
  });
  const res = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: params,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || '카카오 토큰 교환에 실패했습니다.');
  return data; // { access_token, refresh_token, ... }
}

// 리프레시 토큰으로 액세스 토큰을 새로 받는다. 카카오는 리프레시 토큰 잔여 유효기간이
// 1개월 미만일 때만 응답에 새 refresh_token을 실어 보낸다 - 없다고 기존 값을 지우면 안 되고,
// 왔는데 저장을 안 하면 다음 갱신에서 막힌다 (updateKakaoRecipientRefreshTokenIfPresent 참고).
async function refreshKakaoAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.KAKAO_REST_API_KEY || '',
    refresh_token: refreshToken,
    client_secret: process.env.KAKAO_CLIENT_SECRET || '',
  });
  const res = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: params,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || '카카오 토큰 갱신에 실패했습니다.');
  return data; // { access_token, refresh_token?, ... }
}

function upsertKakaoRecipient(label, refreshToken) {
  db.prepare(
    `INSERT INTO kakao_recipients (label, refresh_token, enabled, updated_at)
     VALUES (?, ?, 1, datetime('now'))
     ON CONFLICT(label) DO UPDATE SET refresh_token = excluded.refresh_token, enabled = 1, updated_at = excluded.updated_at`
  ).run(label, refreshToken);
}

function updateKakaoRecipientRefreshTokenIfPresent(label, tokenResponse) {
  if (tokenResponse && tokenResponse.refresh_token) {
    db.prepare(`UPDATE kakao_recipients SET refresh_token = ?, updated_at = datetime('now') WHERE label = ?`)
      .run(tokenResponse.refresh_token, label);
  }
}

function kstTodayInfo() {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now);
  const weekday = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(now).replace('요일', '').trim();
  const [, m, d] = ymd.split('-');
  return { month: Number(m), day: Number(d), weekday };
}

function kstDateStringPlusDays(days) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(Date.now() + days * 86400000));
}

// 오늘(KST) 일정만 뽑는다. HTTP로 /api/schedules를 다시 부르지 않고 같은 프로세스 안에서 직접 조회한다.
// 이 앱은 모든 일정을 하루짜리 종일 이벤트로만 저장하며(start_at === end_at, 시각은 항상 자정 고정),
// /api/schedules의 "start_at < end AND end_at > start" 부등호 비교는 이 경우 start_at===end_at인
// 날짜의 이벤트를 걸러내지 못한다(등호 경계라 end_at > start가 거짓이 됨) - 그래서 여기서는 그 로직을
// 그대로 베끼지 않고, 오늘 날짜(YYYY-MM-DD) 접두어가 정확히 일치하는지로 직접 비교한다.
// is_private=1(관리자 전용 비공개 일정)은 항상 제외한다.
function getTodaysScheduleForNotify() {
  const todayStr = kstDateStringPlusDays(0);
  return db
    .prepare(`SELECT * FROM schedules WHERE substr(start_at, 1, 10) = ? AND is_private = 0 ORDER BY id`)
    .all(todayStr);
}

// 오늘(KST) 마감인 사건관리 서류/보정 제출 항목. case_tasks가 원본이며(OSMU), /api/case-tasks와
// 마찬가지로 구글시트가 아직 원본으로 연동되어 있으면 시트를 우선 읽는다(보통은 이미 앱으로
// 전환되어 있어 SQLite로 조회됨). 완료/예정과 무관하게 오늘 마감인 건은 모두 포함해 팀 스케줄
// 달력이 오늘 보여주는 것과 동일하게 맞춘다. 단, '연기'는 제외한다 - 보정연기로 이미 새 마감일의
// 새 건이 따로 만들어졌으므로, 원래 건이 오늘 마감이었더라도 더 이상 실제로 챙길 필요가 없다.
async function getTodaysCaseTasksForNotify() {
  const todayStr = kstDateStringPlusDays(0);
  try {
    const sheetTasks = await readTasksFromSheetIfConnected();
    if (sheetTasks) return sheetTasks.filter((t) => t.due_date === todayStr && t.status !== '연기');
  } catch (err) {
    console.error('[kakao] 구글시트 일정_보정관리 읽기 실패, SQLite로 대체합니다:', err.message);
  }
  return db.prepare(`SELECT * FROM case_tasks WHERE due_date = ? AND status != '연기' ORDER BY id`).all(todayStr).map(caseTaskWithCase);
}

// 오늘(KST) 마감인 수임료 분할납부 회차. case_fee_installments가 원본(OSMU) - 수임료 전용
// 캘린더(fee-calendar.html)와 동일한 데이터를 그대로 재사용한다. include_fee_calendar=1인
// 수신자(예: 관리자 본인 폰)에게만 포함해서 보낸다 - sendDailyKakaoNotifications 참고.
function getTodaysFeeInstallmentsForNotify() {
  const todayStr = kstDateStringPlusDays(0);
  return db
    .prepare(
      `SELECT fi.*, c.client_name FROM case_fee_installments fi
       JOIN cases c ON c.id = fi.case_id
       WHERE fi.due_date = ?
       ORDER BY fi.id`
    )
    .all(todayStr);
}

// 사건관리(case_tasks) 항목 한 줄. 오늘 마감 항목만 다루므로 상태만으로 아이콘을 구분한다
// (완료✅ / 아직 남음🔴 - 팀 스케줄 달력의 caseTaskEventIcon과 같은 의미).
function caseTaskNotifyLine(t) {
  const icon = t.status === '완료' ? '✅' : '🔴';
  const name = t.client_name ? `${t.client_name} ` : '';
  return `${icon} ${name}${t.task_type}`;
}

// 수임료 분할납부 회차 한 줄.
function feeInstallmentNotifyLine(f) {
  const icon = f.status === '완료' ? '✅' : '💰';
  const amount = Number(f.amount || 0).toLocaleString('ko-KR');
  return `${icon} ${f.client_name || ''} ${f.seq}회차 ${amount}원`;
}

// 카카오 "나에게 보내기" text 오브젝트는 최대 200자까지만 지원한다(카카오 공식 문서 기준).
// 넘치면 뒤에서부터 줄여서 "…외 N건"으로 안내한다. feeInstallments는 생략 가능 - 수신자별로
// 수임료 캘린더 포함 여부가 다르기 때문(sendDailyKakaoNotifications 참고).
function formatDailyKakaoMessage(schedules, caseTasks, feeInstallments) {
  const { month, day, weekday } = kstTodayInfo();
  const scheduleLines = schedules.map((s) => `${s.all_day ? '종일' : String(s.start_at || '').slice(11, 16)} ${s.title}`);
  const taskLines = (caseTasks || []).map(caseTaskNotifyLine);
  const feeLines = (feeInstallments || []).map(feeInstallmentNotifyLine);
  const lines = [...scheduleLines, ...taskLines, ...feeLines];

  if (!lines.length) {
    return `📅 ${month}월 ${day}일 (${weekday})\n오늘 등록된 일정이 없습니다`;
  }
  const header = `📅 ${month}월 ${day}일 (${weekday}) 오늘 일정 ${lines.length}건`;

  const full = [header, ...lines].join('\n');
  if (full.length <= 200) return full;

  for (let shown = lines.length - 1; shown >= 0; shown -= 1) {
    const candidate = [header, ...lines.slice(0, shown), `…외 ${lines.length - shown}건 (앱에서 확인)`].join('\n');
    if (candidate.length <= 200) return candidate;
  }
  return header.slice(0, 200);
}

async function sendKakaoMemo(accessToken, text) {
  const linkUrl = process.env.KAKAO_LINK_URL || '';
  const templateObject = {
    object_type: 'text',
    text,
    link: { web_url: linkUrl, mobile_web_url: linkUrl },
    button_title: '일정 보기',
  };
  const res = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
    body: new URLSearchParams({ template_object: JSON.stringify(templateObject) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result_code !== 0) {
    throw new Error(`카카오 발송 실패 (HTTP ${res.status}, result_code=${data.result_code}): ${data.msg || JSON.stringify(data)}`);
  }
  return data;
}

async function sendDailyKakaoNotifications() {
  if (!process.env.KAKAO_REST_API_KEY || !process.env.KAKAO_CLIENT_SECRET) {
    console.warn('[kakao] KAKAO_REST_API_KEY/KAKAO_CLIENT_SECRET 미설정 - 일정 알림 발송을 건너뜁니다.');
    return { skipped: true, reason: 'env not configured' };
  }
  let recipients = db.prepare('SELECT * FROM kakao_recipients WHERE enabled = 1').all();
  const schedules = getTodaysScheduleForNotify();
  const caseTasks = await getTodaysCaseTasksForNotify();
  // 수임료 캘린더는 include_fee_calendar=1인 수신자가 한 명이라도 있을 때만 계산한다(불필요한 조회 방지).
  const feeInstallments = recipients.some((r) => r.include_fee_calendar) ? getTodaysFeeInstallmentsForNotify() : [];

  // 토/일(주말)에는 사무실이 쉬는 날이므로: 오늘 챙길 항목(일정/사건관리/수임료)이 하나도 없으면
  // 아예 보내지 않고, 있을 때만 대표님 폰("내업무폰")에게만 보낸다 - 직원 폰은 주말엔 울리지 않는다.
  const { weekday } = kstTodayInfo();
  const isWeekend = weekday === '토' || weekday === '일';
  if (isWeekend) {
    const hasAnything = schedules.length > 0 || caseTasks.length > 0 || feeInstallments.length > 0;
    if (!hasAnything) return { skipped: true, reason: 'weekend, nothing scheduled' };
    recipients = recipients.filter((r) => r.label === '내업무폰');
    if (!recipients.length) return { skipped: true, reason: 'weekend, 내업무폰 수신자가 등록되어 있지 않음' };
  }

  const baseMessage = formatDailyKakaoMessage(schedules, caseTasks);
  const feeMessage = feeInstallments.length ? formatDailyKakaoMessage(schedules, caseTasks, feeInstallments) : baseMessage;

  const results = [];
  for (const r of recipients) {
    const message = r.include_fee_calendar ? feeMessage : baseMessage;
    try {
      const tokenRes = await refreshKakaoAccessToken(r.refresh_token);
      updateKakaoRecipientRefreshTokenIfPresent(r.label, tokenRes);
      await sendKakaoMemo(tokenRes.access_token, message);
      results.push({ label: r.label, ok: true });
    } catch (err) {
      console.error(`[kakao] ${r.label} 발송 실패:`, err.message);
      results.push({ label: r.label, ok: false, error: err.message });
    }
  }
  return { message: baseMessage, recipientCount: recipients.length, results };
}

// 메모 저장 즉시 알림(카톡): 일일 알림(sendDailyKakaoNotifications)과 같은 방식으로 등록된 모든
// 수신자(내업무폰/직원업무폰)에게 각자의 토큰으로 개별 발송한다(OSMU) - 다만 이건 매일이 아니라
// 메모가 남을 때마다 즉시 트리거된다. 한 명이라도 발송이 실패해도 나머지 수신자에게는 계속 보낸다.
// 카카오와 별개로, 로그인해서 "알림 켜기"를 누른 직원의 기기에는 웹 푸시로도 함께 보낸다(OSMU) -
// 카카오 계정 연동 없이도 직원 수만큼 자연히 늘어나는 채널이라 카카오를 대체하지 않고 병행한다.
async function notifyCaseNoteAdded(caseRow, note) {
  const preview = note.content.length > 200 ? note.content.slice(0, 200) + '…' : note.content;
  const message = `📝 메모 등록 알림\n\n${caseRow.client_name}님 사건에 메모가 남겨졌습니다.\n작성자: ${note.author_name || ''}\n\n${preview}`;

  sendPushToAll({
    title: `${caseRow.client_name}님 사건에 메모가 남겨졌습니다`,
    body: preview,
    url: `/case-detail.html?id=${caseRow.id}`,
  }).catch((err) => console.error('[push] 메모 알림 발송 실패:', err.message));

  if (!process.env.KAKAO_REST_API_KEY || !process.env.KAKAO_CLIENT_SECRET) return;
  const recipients = db.prepare('SELECT * FROM kakao_recipients WHERE enabled = 1').all();
  if (!recipients.length) return;

  for (const r of recipients) {
    try {
      const tokenRes = await refreshKakaoAccessToken(r.refresh_token);
      updateKakaoRecipientRefreshTokenIfPresent(r.label, tokenRes);
      await sendKakaoMemo(tokenRes.access_token, message);
    } catch (err) {
      console.error(`[kakao] ${r.label} 메모 알림 발송 실패:`, err.message);
    }
  }
}

// 최초 1회용 수신자 등록. label(예: 내업무폰/직원업무폰)이 등록될 폰 브라우저에서 직접 열어서 사용한다.
app.get('/kakao/link', (req, res) => {
  const { label, key } = req.query;
  if (!label) return res.status(400).send('label 파라미터가 필요합니다.');
  if (!process.env.KAKAO_LINK_SETUP_KEY || key !== process.env.KAKAO_LINK_SETUP_KEY) {
    return res.status(403).send('접근 권한이 없습니다.');
  }
  if (!process.env.KAKAO_REST_API_KEY || !process.env.KAKAO_REDIRECT_URI) {
    return res.status(500).send('카카오 연동 환경변수가 설정되지 않았습니다.');
  }
  const url = new URL('https://kauth.kakao.com/oauth/authorize');
  url.searchParams.set('client_id', process.env.KAKAO_REST_API_KEY);
  url.searchParams.set('redirect_uri', process.env.KAKAO_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'talk_message');
  url.searchParams.set('state', signKakaoLinkState(label));
  res.redirect(url.toString());
});

app.get('/kakao/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`카카오 인증이 취소되었습니다: ${error}`);
  const label = verifyKakaoLinkState(state);
  if (!label) return res.status(400).send('유효하지 않거나 만료된 요청입니다. 등록 링크를 다시 요청해주세요.');
  if (!code) return res.status(400).send('인증 코드가 없습니다.');
  try {
    const tokens = await exchangeKakaoAuthCode(code);
    if (!tokens.refresh_token) throw new Error('카카오로부터 refresh_token을 받지 못했습니다.');
    upsertKakaoRecipient(label, tokens.refresh_token);
    res.send(
      `<html><body style="font-family:sans-serif; text-align:center; padding:60px 20px;">` +
      `<h2>등록 완료 ✅</h2><p>"${label}" 계정으로 매일 아침 일정 알림이 발송됩니다.</p>` +
      `<p style="color:#888; font-size:13px;">이 창은 닫으셔도 됩니다.</p></body></html>`
    );
  } catch (err) {
    console.error('카카오 연동 실패:', err.message);
    res.status(500).send('카카오 연동 중 오류가 발생했습니다: ' + err.message);
  }
});

// 외부 스케줄러(GitHub Actions 등)가 매일 아침 호출하는 발송 엔드포인트.
app.post('/api/notify/daily', async (req, res) => {
  const key = req.get('X-Notify-Key') || req.query.key;
  if (!process.env.KAKAO_NOTIFY_KEY || key !== process.env.KAKAO_NOTIFY_KEY) {
    return res.status(403).json({ error: '권한이 없습니다.' });
  }
  try {
    res.json(await sendDailyKakaoNotifications());
  } catch (err) {
    console.error('일정 알림 발송 실패:', err);
    res.status(500).json({ error: err.message });
  }
});

// 관리자가 직접 테스트/재발송할 때 쓰는 수동 실행용.
app.post('/api/admin/notify/daily/test', requireAdmin, async (req, res) => {
  try {
    res.json(await sendDailyKakaoNotifications());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/kakao/recipients', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT label, enabled, include_fee_calendar, updated_at FROM kakao_recipients ORDER BY label').all());
});

app.patch('/api/kakao/recipients/:label', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM kakao_recipients WHERE label = ?').get(req.params.label);
  if (!existing) return res.status(404).json({ error: '등록되지 않은 수신자입니다.' });
  const body = req.body || {};
  const enabled = 'enabled' in body ? (body.enabled ? 1 : 0) : existing.enabled;
  const includeFee = 'include_fee_calendar' in body ? (body.include_fee_calendar ? 1 : 0) : existing.include_fee_calendar;
  db.prepare(`UPDATE kakao_recipients SET enabled = ?, include_fee_calendar = ?, updated_at = datetime('now') WHERE label = ?`)
    .run(enabled, includeFee, req.params.label);
  res.json({ ok: true });
});

app.delete('/api/kakao/recipients/:label', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM kakao_recipients WHERE label = ?').run(req.params.label);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* 웹 푸시 알림                                                        */
/* ------------------------------------------------------------------ */
// 카카오톡 "나에게 보내기"는 사전에 등록해둔 고정 2개 계정(내업무폰/직원업무폰)에만 보낼 수 있는데,
// 웹 푸시는 로그인한 직원이 각자 자기 기기(폰 브라우저 등)에서 "알림 켜기"만 누르면 그 기기로 바로
// 알림이 온다 - 카카오 계정 연동 없이 직원 수만큼 자연히 채널이 늘어난다. VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY 환경변수가 없으면 카카오와 동일하게 조용히 아무 것도 보내지 않는다(no-op).
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@beopjin.local',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

app.get('/api/push/vapid-public-key', requireLogin, (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY || null });
});

app.get('/api/push/status', requireLogin, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE employee_id = ?').get(req.user.id).c;
  res.json({ subscribed: count > 0, configured: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) });
});

app.post('/api/push/subscribe', requireLogin, (req, res) => {
  const sub = (req.body && req.body.subscription) || req.body || {};
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: '유효하지 않은 구독 정보입니다.' });
  }
  db.prepare(`
    INSERT INTO push_subscriptions (employee_id, endpoint, p256dh, auth, user_agent)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      employee_id = excluded.employee_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent
  `).run(req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, (req.get('User-Agent') || '').slice(0, 300));
  res.status(201).json({ ok: true });
});

app.post('/api/push/unsubscribe', requireLogin, (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint가 필요합니다.' });
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND employee_id = ?').run(endpoint, req.user.id);
  res.json({ ok: true });
});

// 등록된 모든 구독(=알림을 켠 모든 직원의 모든 기기)에 보낸다. 카카오와 마찬가지로 한 기기 발송
// 실패가 다른 기기 발송을 막지 않는다. 브라우저가 구독을 스스로 취소/만료시킨 경우(410/404)는
// 다음부터 조용히 제외되도록 그 구독을 정리한다.
async function sendPushToAll(payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  const body = JSON.stringify(payload);
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      } else {
        console.error('[push] 발송 실패:', err.message);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 의뢰인용 진행현황 조회 (로그인 불필요 — 이 파일에서 유일하게 세션 인증을    */
/* 요구하지 않는 구간. 이름+생년월일만으로 본인 사건 하나만 조회하게 하고,     */
/* 상태/다음 일정 외에는 아무것도 내려주지 않는다.)                          */
/* ------------------------------------------------------------------ */

// 무차별 대입(같은 이름으로 생년월일을 계속 바꿔가며 시도) 방지용 요청 횟수 제한.
// IP별 최근 시도 시각을 메모리에만 들고 있는다 — 재배포/재시작되면 초기화되지만, 이 정도
// 시도-횟수 제한에는 별도 DB나 외부 저장소를 새로 둘 만큼의 무게가 필요하지 않다.
const portalAttempts = new Map(); // ip -> [timestamp, ...]
const PORTAL_LIMIT_PER_MIN = 5;
const PORTAL_LIMIT_PER_HOUR = 20;

function checkPortalRateLimit(ip) {
  const now = Date.now();
  const recent = (portalAttempts.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  const lastMinute = recent.filter((t) => now - t < 60 * 1000).length;
  if (lastMinute >= PORTAL_LIMIT_PER_MIN || recent.length >= PORTAL_LIMIT_PER_HOUR) {
    portalAttempts.set(ip, recent);
    return false;
  }
  recent.push(now);
  portalAttempts.set(ip, recent);
  return true;
}
// 오래된 IP 기록이 메모리에 계속 쌓이지 않도록 주기적으로 정리한다.
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of portalAttempts.entries()) {
    const fresh = list.filter((t) => now - t < 60 * 60 * 1000);
    if (fresh.length) portalAttempts.set(ip, fresh);
    else portalAttempts.delete(ip);
  }
}, 10 * 60 * 1000).unref();

app.post('/api/portal/status', (req, res) => {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  if (!checkPortalRateLimit(ip)) {
    return res.status(429).json({ error: '시도 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.' });
  }

  const name = String((req.body && req.body.name) || '').trim();
  const birthDate = String((req.body && req.body.birth_date) || '').trim();
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
    return res.status(400).json({ error: '이름과 생년월일을 정확히 입력해주세요.' });
  }

  const nameKey = normalizeMatchKey(name);
  const candidates = db.prepare('SELECT * FROM cases WHERE birth_date = ?').all(birthDate)
    .filter((c) => normalizeMatchKey(c.client_name) === nameKey);

  // 이름이 틀렸는지 생년월일이 틀렸는지, 혹은 아직 사무소에서 생년월일을 등록해두지 않았는지
  // 구분해서 알려주지 않는다 — 어느 쪽이든 외부에서는 "일치 정보 없음"으로만 보여야 한다.
  // 동명이인+동일 생년월일이 우연히 겹치는 경우도 이론상 있을 수 있으므로, 그럴 때도 추측해서
  // 아무 사건이나 보여주지 않고 안내만 한다.
  if (candidates.length !== 1) {
    return res.status(404).json({ error: '일치하는 사건을 찾을 수 없습니다. 담당 사무소로 문의해주세요.' });
  }

  const matched = candidates[0];
  const nextTask = db
    .prepare(`SELECT task_type, due_date FROM case_tasks WHERE case_id = ? AND due_date >= date('now') ORDER BY due_date ASC LIMIT 1`)
    .get(matched.id);

  // 사건유형별 세로 타임라인(현재는 개인회생만) — 각 단계에 기록된 날짜(들)를 붙이고, 기록이 있는
  // 단계 중 목록상 가장 뒤에 있는 것을 "현재 단계"로 본다. 반복되는 단계(보정권고송달/제출)는
  // dates 배열에 여러 값이 그대로 담겨 나간다(=n회차를 그대로 보여줄 수 있음).
  const allowedStages = CASE_STAGE_TIMELINE[matched.case_type] || [];
  let timeline = null;
  if (allowedStages.length) {
    const events = db
      .prepare('SELECT stage, event_date FROM case_stage_events WHERE case_id = ? ORDER BY event_date ASC, id ASC')
      .all(matched.id);
    const datesByStage = {};
    events.forEach((e) => { (datesByStage[e.stage] = datesByStage[e.stage] || []).push(e.event_date); });
    let currentIndex = -1;
    allowedStages.forEach((s, i) => { if (datesByStage[s] && datesByStage[s].length) currentIndex = i; });
    timeline = allowedStages.map((s, i) => ({
      stage: s,
      dates: datesByStage[s] || [],
      reached: i <= currentIndex,
      current: i === currentIndex,
    }));
  }

  // 응답은 의도적으로 이 값들만 준다 — 메모/담당자/파일/고객등급/수임료 등은 절대 포함하지 않는다.
  // court/case_type/court_case_no는 의뢰인 본인도 이미 알고 있는(계약 시 안내받은) 사건 식별 정보라
  // 노출 대상에 포함한다 — client-status.html의 "사건 기본정보" 카드 제목에 그대로 쓰인다.
  // timeline이 없는 사건유형(개인회생 외)은 기존 방식대로 status 배지 + 다음 일정만 내려간다.
  res.json({
    client_name: matched.client_name,
    status: matched.status || '',
    court: matched.court || '',
    case_type: matched.case_type || '',
    court_case_no: matched.court_case_no || '',
    timeline,
    next_task: nextTask ? { task_type: nextTask.task_type, due_date: nextTask.due_date } : null,
  });
});

app.get('/client-status.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'client-status.html'));
});

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

app.get('/consultations.html', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'consultations.html'));
});

app.get('/consult-report.html', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'consult-report.html'));
});

app.get('/settings.html', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'settings.html'));
});

app.get('/fee-calendar.html', (req, res) => {
  // 관리자 여부는 프론트에서(다른 관리자 전용 페이지와 동일한 패턴으로) 다시 확인하고,
  // 실제 데이터 보호는 /api/admin/fee-calendar* 쪽 requireAdmin 미들웨어가 담당한다.
  if (!req.session || !req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'fee-calendar.html'));
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`); });
