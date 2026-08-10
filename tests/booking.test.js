/* 用 jsdom 實跑 booking.html 的同行旅客邏輯 */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('/home/user/repo/booking.html', 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://inhouse-dcc.pages.dev/booking',
  beforeParse(w) {
    w.fetch = () => new Promise(() => {});          // 不打真的 API
    w.alert = msg => { w.__lastAlert = msg; };
    w.scrollTo = () => {};
  },
});
const w = dom.window, doc = w.document;
const $ = id => doc.getElementById(id);

let fails = 0;
const ok = (cond, label) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label); if (!cond) fails++; };

// 1. 預設 1 人 → 同行旅客區塊隱藏、A 標記隱藏
ok($('companions-section').style.display === 'none', '1 人時同行旅客區塊隱藏');
ok($('main-guest-tag').style.display === 'none', '1 人時不顯示 (A) 標記');

// 2. 加到 4 人 → 出現 B/C/D 三列
w.changeGuests(3);
let rows = doc.querySelectorAll('#companions-list .comp-row');
ok(w.guests === 4, '人數 = 4');
ok(rows.length === 3, '4 人 → 產生 3 列同行旅客 (實際 ' + rows.length + ')');
ok([...doc.querySelectorAll('.comp-tag')].map(e => e.textContent).join('') === 'BCD', '標記依序為 B C D');
ok($('companions-section').style.display !== 'none', '區塊已顯示');
ok($('main-guest-tag').style.display === '', '顯示 (A) 標記');

// 3. 打字後加人數 → 既有的值不能被清掉
const fill = (i, name, phone) => {
  const n = doc.querySelector(`input[data-comp="${i}"][data-field="name"]`);
  const p = doc.querySelector(`input[data-comp="${i}"][data-field="phone"]`);
  n.value = name; n.dispatchEvent(new w.Event('input'));
  p.value = phone; p.dispatchEvent(new w.Event('input'));
};
fill(0, '王小明', '0912345678');
fill(1, '李小華', '0987654321');
fill(2, '陳小美', '0955111222');
w.changeGuests(1); // → 5 人
ok(doc.querySelectorAll('#companions-list .comp-row').length === 4, '加到 5 人 → 4 列');
ok(doc.querySelector('input[data-comp="0"][data-field="name"]').value === '王小明', '加人數後 B 的姓名保留');
ok(doc.querySelector('input[data-comp="2"][data-field="phone"]').value === '0955111222', '加人數後 D 的電話保留');

// 4. 減人數 → 多的列消失，剩下的值保留
w.changeGuests(-2); // → 3 人
ok(doc.querySelectorAll('#companions-list .comp-row').length === 2, '降到 3 人 → 2 列');
ok(doc.querySelector('input[data-comp="1"][data-field="name"]').value === '李小華', '減人數後 C 的姓名保留');

// 5. 切換語言 → 值保留、placeholder 跟著換、標籤翻譯
w.applyLang('ja');
ok(doc.querySelector('input[data-comp="0"][data-field="name"]').value === '王小明', '切日文後值保留');
ok(doc.querySelector('input[data-comp="0"][data-field="phone"]').placeholder === '携帯番号', '切日文後 placeholder 為日文');
ok(doc.querySelector('#companions-section [data-i18n="companions"]').textContent === '同行者', '日文標籤 = 同行者');

// 6. 三語都要有新的錯誤訊息（避免 alert 顯示 undefined）
for (const lang of ['en', 'zh', 'ja']) {
  w.applyLang(lang);
  const d = w.getDict();
  ok(typeof d.companionsRequired === 'string' && d.companionsRequired.length > 0, `[${lang}] companionsRequired 有字串`);
  ok(typeof d.emailInvalid === 'string' && d.emailInvalid.length > 0, `[${lang}] emailInvalid 有字串`);
  ok(typeof d.phCompPhone === 'string' && d.phCompPhone.length > 0, `[${lang}] phCompPhone 有字串`);
}
w.applyLang('zh');

// 7. 驗證：同行旅客電話留空 → 擋下
// 走真正的月曆流程(openCal → selectDay → confirmDate),確保 data-iso 是這條路徑寫進去的
const pickDate = (mode, y, m, d) => { w.openCal(mode); w.selectDay(y, m, d); w.confirmDate(); };
const setupMain = () => {
  $('room-select').value = 'Ocean Double';
  pickDate('checkin',  2026, 8, 10);   // 2026-09-10
  pickDate('checkout', 2026, 8, 12);   // 2026-09-12
  $('name-input').value = '王大明';
  $('phone-input').value = '0911222333';
  $('email-input').value = 'test@example.com';
};
setupMain();
const pBlank = doc.querySelector('input[data-comp="1"][data-field="phone"]');
pBlank.value = ''; pBlank.dispatchEvent(new w.Event('input'));
w.__lastAlert = null;
w.submitForm();
ok(w.__lastAlert === w.getDict().companionsRequired, '同行旅客電話留空 → 跳 companionsRequired');
ok($('confirmScreen').classList.contains('show') === false, '被擋下時沒有進確認畫面');

// 8. Email 格式錯誤 → 跳 emailInvalid（不是 fillRequired）
pBlank.value = '0987654321'; pBlank.dispatchEvent(new w.Event('input'));
$('email-input').value = 'abc@';
w.__lastAlert = null;
w.submitForm();
ok(w.__lastAlert === w.getDict().emailInvalid, 'Email = "abc@" → 跳 emailInvalid');

// 9. Email 留空 → 跳 fillRequired
$('email-input').value = '';
w.__lastAlert = null;
w.submitForm();
ok(w.__lastAlert === w.getDict().fillRequired, 'Email 留空 → 跳 fillRequired');

// 10. 全部填好 → 通過驗證，送出的 notes 內含同行旅客名冊
$('email-input').value = 'test@example.com';
$('notes-input').value = '需要一組蛙鞋';
let sent = null;
w.fetch = (url, opt) => {
  sent = { url, body: JSON.parse(opt.body) };
  return new Promise(() => {});   // 掛住，不繼續跑成功流程
};
w.__lastAlert = null;
w.submitForm();
ok(w.__lastAlert === null, '全部填妥 → 沒有跳錯誤');
ok(sent !== null && /\/booking$/.test(sent.url), '有送出 POST /booking');
if (sent) {
  const n = sent.body.notes;
  console.log('\n--- 送出的 notes ---\n' + n + '\n--------------------');
  ok(/同行旅客/.test(n), 'notes 含「同行旅客」標題');
  ok(/B 王小明 0912345678/.test(n), 'notes 含 B 王小明');
  ok(/C 李小華 0987654321/.test(n), 'notes 含 C 李小華');
  ok(/需要一組蛙鞋/.test(n), 'notes 保留客人自己寫的備註');
  ok(sent.body.guests === 3, 'guests = 3');
  ok(sent.body.guest_email === 'test@example.com', 'guest_email 有帶');
  ok(sent.body.checkin_date === '2026-09-10', 'checkin_date 沒有差一天 (2026-09-10)');
  ok(sent.body.checkout_date === '2026-09-12', 'checkout_date 沒有差一天 (2026-09-12)');
}

// 10b. 三種語言下送出的日期都必須是同一組 ISO
//      （日期顯示已改為依語種翻譯，若哪天有人又從畫面文字反推日期，中日文會直接解析失敗）
for (const [lang, label] of [['en', 'Sep 10, 2026'], ['zh', '2026年9月10日'], ['ja', '2026年9月10日']]) {
  w.applyLang(lang);
  ok($('checkin-text').textContent === label, `[${lang}] 入住日顯示為 ${label}`);
  sent = null;
  w.submitForm();
  ok(sent && sent.body.checkin_date  === '2026-09-10', `[${lang}] 送出的 checkin_date 仍是 2026-09-10`);
  ok(sent && sent.body.checkout_date === '2026-09-12', `[${lang}] 送出的 checkout_date 仍是 2026-09-12`);
}
w.applyLang('zh');

// 10c. 月曆標題也要依語種顯示
w.openCal('checkin');
ok($('cal-month-label').textContent === `${new Date().getFullYear()}年${new Date().getMonth() + 1}月`, '中文月曆標題為「YYYY年M月」');
w.applyLang('en');
w.renderCal();
ok(/^[A-Z][a-z]{2} \d{4}$/.test($('cal-month-label').textContent), '英文月曆標題為「Mon YYYY」');
w.closeCal();
w.applyLang('zh');

// 11. 草稿存還原（模擬 LINE 登入來回）
w.saveDraft();
const draft = JSON.parse(w.sessionStorage.getItem('bookingDraft'));
ok(Array.isArray(draft.companions) && draft.companions.length === 2, '草稿存進 2 位同行旅客');
ok(draft.companions[0].name === '王小明', '草稿內含 B 的姓名');
// 清空現況，模擬重新載入頁面後還原
w.companions = [];
w.guests = 1;
w.restoreDraft();
ok(w.guests === 3, '還原後人數 = 3');
ok(doc.querySelectorAll('#companions-list .comp-row').length === 2, '還原後重建 2 列');
ok(doc.querySelector('input[data-comp="0"][data-field="name"]').value === '王小明', '還原後 B 的姓名回來了');
ok(doc.querySelector('input[data-comp="1"][data-field="phone"]').value === '0987654321', '還原後 C 的電話回來了');
ok($('email-input').value === 'test@example.com', '還原後 Email 回來了');
ok($('checkin-btn').dataset.iso === '2026-09-10', '還原後入住日期回來了 (data-iso)');
ok($('checkin-btn').classList.contains('filled'), '還原後入住日期按鈕是已填狀態');
ok($('checkin-text').textContent === '2026年9月10日', '還原後日期用當下語言(中文)顯示');

// 11b. 舊版草稿(存的是顯示文字而非 ISO)要被擋掉,不能當成有效日期送出
w.sessionStorage.setItem('bookingDraft', JSON.stringify({ checkin: 'Sep 10, 2026', checkout: 'Sep 12, 2026' }));
$('checkin-btn').classList.remove('filled');  delete $('checkin-btn').dataset.iso;
$('checkout-btn').classList.remove('filled'); delete $('checkout-btn').dataset.iso;
w.restoreDraft();
ok(!$('checkin-btn').dataset.iso, '舊版草稿的日期文字不會被當成 ISO 收下');
ok(!$('checkin-btn').classList.contains('filled'), '舊版草稿日期 → 按鈕維持未填,客人需重選');

// 12. HTML 注入防護
w.guests = 2; w.companions = [{ name: '<img src=x onerror=1>', phone: '"><b>x' }];
w.renderCompanions();
ok(doc.querySelectorAll('#companions-list img').length === 0, '姓名含 HTML 不會被當標籤解析');
ok(doc.querySelector('input[data-comp="0"][data-field="phone"]').value === '"><b>x', '電話含引號仍正確帶入 value');

console.log('\n' + (fails === 0 ? '全部通過' : fails + ' 項失敗'));
process.exit(fails === 0 ? 0 : 1);
