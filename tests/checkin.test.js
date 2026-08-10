/* 用 jsdom 實跑 checkin.html：日期顯示要跟著語言走 */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const dom = new JSDOM(fs.readFileSync('/home/user/repo/checkin.html', 'utf8'), {
  runScripts: 'dangerously',
  url: 'https://inhouse-dcc.pages.dev/checkin',
  beforeParse(w) {
    w.fetch = () => new Promise(() => {});   // 預設不打真的 API
    w.alert = () => {};
    w.scrollTo = () => {};
  },
});
const w = dom.window, doc = w.document;
const $ = id => doc.getElementById(id);

let fails = 0;
const ok = (cond, label) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label); if (!cond) fails++; };

(async () => {

// 1. 還沒驗證訂單就切語言 → 不能出錯（此時內部 booking 仍是 null）
let threw = false;
try { w.setLang('en'); w.setLang('zh'); } catch (e) { threw = true; console.log(e); }
ok(!threw, '尚未驗證訂單時切語言不會出錯');

// 2. 走真正的驗證流程把訂單灌進去（booking 是 let，從外面指定 window.booking 沒有用）
$('booking-code').value = 'IH-20260910-001';
$('phone-last4').value  = '3687';
w.fetch = () => Promise.resolve({
  ok: true,
  json: () => Promise.resolve({
    ok: true,
    recordId: 'recTEST',
    booking: { room: 'Ocean Double', checkin: '2026-09-10', checkout: '2026-09-12', guests: 2 },
  }),
});
await w.verifyBooking();

ok($('b-checkin').textContent === '2026年9月10日', '預設中文 → 2026年9月10日 (實際 ' + $('b-checkin').textContent + ')');

// 3. 切語言 → 已顯示的日期要跟著重排
w.setLang('en');
ok($('b-checkin').textContent  === 'Sep 10, 2026', '切 EN → 入住日 Sep 10, 2026 (實際 ' + $('b-checkin').textContent + ')');
ok($('b-checkout').textContent === 'Sep 12, 2026', '切 EN → 退房日也一起重排');

w.setLang('ja');
ok($('b-checkin').textContent === '2026年9月10日', '切日文 → 2026年9月10日');

w.setLang('zh');
ok($('b-checkin').textContent === '2026年9月10日', '切回中文 → 2026年9月10日');

// 4. 最終確認面板的日期也要跟著語言走
w.fillConfirmPanel();
ok($('c-cin').textContent === '2026年9月10日', '確認面板中文 → 2026年9月10日');
w.setLang('en');
ok($('c-cin').textContent === 'Sep 10, 2026', '確認面板切 EN → Sep 10, 2026');
w.setLang('zh');

// 5. 邊界：壞值不能變成「NaN 年 NaN 月」
ok(w.formatDate('')      === '—',     '空值 → —');
ok(w.formatDate(null)    === '—',     'null → —');
ok(w.formatDate('bogus') === 'bogus', '非 ISO 原樣回傳,不會變 NaN');

console.log('\n' + (fails === 0 ? '全部通過' : fails + ' 項失敗'));
process.exit(fails === 0 ? 0 : 1);

})();
