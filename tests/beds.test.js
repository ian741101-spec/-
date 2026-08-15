/* 用 jsdom 實跑 booking.html 的通鋪床位 / 包房邏輯 */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('/home/user/repo/booking.html', 'utf8');

// /availability 的假回應:通鋪 2 床,8/19 已被訂走 1 床,8/20 兩床都滿
const AVAIL = {
  'Intertidal Bunk': { blocked: ['2026-08-19', '2026-08-20', '2026-08-20'], capacity: 2,
                       remaining: { '2026-08-19': 1, '2026-08-20': 0 } },
  'Ocean Double':    { blocked: ['2026-08-19'], capacity: 1, remaining: { '2026-08-19': 0 } },
};

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://inhouse-dcc.pages.dev/booking',
  beforeParse(w) {
    w.fetch = (url) => {
      const room = decodeURIComponent(String(url).split('room_type=')[1] || '');
      const body = AVAIL[room] || { blocked: [], capacity: 1, remaining: {} };
      return Promise.resolve({ json: () => Promise.resolve(body) });
    };
    w.alert = msg => { w.__lastAlert = msg; };
    w.scrollTo = () => {};
  },
});
const w = dom.window, doc = w.document;
const $ = id => doc.getElementById(id);

let fails = 0;
const ok = (cond, label) => { console.log((cond ? '  PASS  ' : '  FAIL  ') + label); if (!cond) fails++; };

// fetch 是 Promise,等 microtask 排完再驗
const settle = () => new Promise(r => setTimeout(r, 0));

const pickRoom = async (room) => {
  $('room-select').value = room;
  $('room-select').dispatchEvent(new w.Event('change'));
  await settle();
};

(async () => {
  // ── 1. 私人房:看不到包房選項 ──
  await pickRoom('Ocean Double');
  ok($('whole-room-section').style.display === 'none', '私人房不顯示包房選項');
  ok(w.bedsNeeded() === 1, '私人房一律算 1 間');
  w.changeGuests(3);
  ok(w.guests === 4, '私人房人數可以超過 2 (實際 ' + w.guests + ')');
  ok(w.bedsNeeded() === 1, '私人房加人數不影響床位');
  ok(w.isDateFull('2026-08-19') === true, '私人房已被訂的日期 → 擋住');
  ok(w.isDateFull('2026-08-18') === false, '私人房沒人訂的日期 → 開放');

  // ── 2. 切到通鋪:包房選項出現,人數被壓回 2 ──
  await pickRoom('Intertidal Bunk');
  ok($('whole-room-section').style.display !== 'none', '通鋪顯示包房選項');
  ok(w.guests === 2, '從 4 人切到通鋪 → 人數壓回 2 (實際 ' + w.guests + ')');
  ok($('guests-num').textContent === '2', '畫面上的人數也跟著改');
  ok(doc.querySelectorAll('#companions-list .comp-row').length === 1,
     '同行旅客列跟著縮成 1 列 (實際 ' + doc.querySelectorAll('#companions-list .comp-row').length + ')');

  // ── 3. 人數加不過床位數 ──
  w.changeGuests(5);
  ok(w.guests === 2, '通鋪人數上限是 2,按再多次也不會超過 (實際 ' + w.guests + ')');

  // ── 4. 剩 1 床的日期:1 人訂得到,2 人訂不到 ──
  w.changeGuests(-1);
  ok(w.guests === 1 && w.bedsNeeded() === 1, '改成 1 人 → 需要 1 床');
  ok(w.isDateFull('2026-08-19') === false, '剩 1 床的日期,1 人訂得到');
  ok(w.isDateFull('2026-08-20') === true,  '0 床的日期,1 人也訂不到');
  ok(w.isDateFull('2026-08-18') === false, '沒人訂的日期,開放');

  w.changeGuests(1);
  ok(w.bedsNeeded() === 2, '改成 2 人 → 需要 2 床');
  ok(w.isDateFull('2026-08-19') === true, '剩 1 床的日期,2 人訂不到');

  // ── 5. 包房:一個人也占滿整間,而且不用填同行旅客 ──
  w.changeGuests(-1);
  $('whole-room-check').checked = true;
  $('whole-room-check').dispatchEvent(new w.Event('change'));
  ok(w.wholeRoom === true, '包房已勾選');
  ok(w.guests === 1, '包房不會偷偷把人數改成 2 (實際 ' + w.guests + ')');
  ok(w.bedsNeeded() === 2, '包房 → 需要 2 床');
  ok(doc.querySelectorAll('#companions-list .comp-row').length === 0,
     '一個人包房不必填同行旅客');
  ok(w.isDateFull('2026-08-19') === true, '剩 1 床的日期不能包房');

  // ── 6. 取消包房 → 回到 1 床 ──
  $('whole-room-check').checked = false;
  $('whole-room-check').dispatchEvent(new w.Event('change'));
  ok(w.bedsNeeded() === 1, '取消包房 → 回到 1 床');
  ok(w.isDateFull('2026-08-19') === false, '取消後剩 1 床的日期又訂得到');

  // ── 7. 切回私人房 → 包房狀態要清掉 ──
  $('whole-room-check').checked = true;
  $('whole-room-check').dispatchEvent(new w.Event('change'));
  await pickRoom('Ocean Double');
  ok(w.wholeRoom === false, '切回私人房 → 包房狀態清掉');
  ok($('whole-room-check').checked === false, '包房打勾也一併取消');

  // ── 8. 舊版 Worker(沒有 remaining)→ 退回保守判斷 ──
  await pickRoom('Intertidal Bunk');
  w.availability = { blocked: ['2026-08-19'], capacity: 1, remaining: null };
  ok(w.isDateFull('2026-08-19') === true, '舊版 Worker 回應 → 有人訂就整天擋掉');
  ok(w.isDateFull('2026-08-18') === false, '舊版 Worker 回應 → 沒人訂的日期照常開放');

  // ── 9. 沒選房型時不准開月曆(不然會把賣掉的日期顯示成可選)──
  $('room-select').value = '';
  $('room-select').dispatchEvent(new w.Event('change'));
  await settle();
  w.__lastAlert = null;
  w.openCal('checkin');
  ok(!!w.__lastAlert && w.__lastAlert === w.getDict().pickRoomFirst,
     '沒選房型點日期 → 跳出「請先選房型」提示');
  ok($('calOverlay').classList.contains('open') === false, '沒選房型 → 月曆不會打開');

  // ── 10. 換房型/改床位後,已選但訂不到的日期要當場清掉 ──
  await pickRoom('Intertidal Bunk');
  const setDate = (btnId, iso) => {
    const b = $(btnId); b.dataset.iso = iso; b.classList.add('filled');
  };
  setDate('checkin-btn', '2026-08-19');   // 剩 1 床
  setDate('checkout-btn', '2026-08-20');
  w.__lastAlert = null;
  w.changeGuests(1);                      // 變成 2 人 → 需要 2 床 → 不夠
  ok($('checkin-btn').dataset.iso === '', '床位不夠 → 入住日被清掉');
  ok($('checkout-btn').dataset.iso === '', '床位不夠 → 退房日被清掉');
  ok($('checkin-btn').classList.contains('filled') === false, '按鈕回到未填狀態');
  ok(!!w.__lastAlert, '有告訴客人日期被清掉了');

  // 反過來:床位夠的話不能亂清客人選好的日期
  w.changeGuests(-1);
  setDate('checkin-btn', '2026-08-19');
  setDate('checkout-btn', '2026-08-20');
  w.__lastAlert = null;
  w.revalidateDates();
  ok($('checkin-btn').dataset.iso === '2026-08-19', '床位夠 → 日期保留');
  ok(w.__lastAlert === null, '床位夠 → 不跳沒必要的提示');

  // ── 11. 退房日的規則和入住日不一樣 ──
  // AVAIL 設定:8/19 剩 1 床、8/20 剩 0 床
  await pickRoom('Intertidal Bunk');
  $('checkin-btn').dataset.iso = '';
  $('checkout-btn').dataset.iso = '';

  w.calMode = 'checkin';
  ok(w.isDateUnselectable('2026-08-20') === true, '選入住日:8/20 客滿 → 不能選');
  ok(w.isDateUnselectable('2026-08-19') === false, '選入住日:8/19 還有床 → 可以選');

  // 8/18 入住,想 8/19 退房(只住 8/18 一晚)—— 8/19 是否客滿都不該影響
  w.availability.remaining['2026-08-19'] = 0;   // 把 8/19 也弄成客滿
  $('checkin-btn').dataset.iso = '2026-08-18';
  w.calMode = 'checkout';
  ok(w.isDateUnselectable('2026-08-19') === false,
     '選退房日:8/19 就算客滿,仍可當退房日(退房當天不算住宿)');
  ok(w.isDateUnselectable('2026-08-18') === true, '選退房日:不能早於或等於入住日');
  ok(w.isDateUnselectable('2026-08-21') === true,
     '選退房日:8/21 會跨過客滿的 8/19、8/20 → 擋掉');

  // 中間沒有客滿的日子就要放行
  w.availability.remaining['2026-08-19'] = 1;
  w.availability.remaining['2026-08-20'] = 1;
  ok(w.isDateUnselectable('2026-08-21') === false, '中間都有床 → 8/21 可當退房日');

  // ── 12. 改入住日後,不合理的退房日要自動清掉 ──
  w.availability.remaining['2026-08-20'] = 0;
  $('checkin-btn').dataset.iso = '2026-08-18';
  $('checkout-btn').dataset.iso = '2026-08-19';
  $('checkout-btn').classList.add('filled');
  w.calMode = 'checkin';
  w.selectedDate = new Date(2026, 7, 25);       // 把入住日改到 8/25(晚於原退房日)
  w.confirmDate();
  ok($('checkout-btn').dataset.iso === '', '入住日改到退房日之後 → 退房日被清掉');
  ok($('checkout-btn').classList.contains('filled') === false, '退房按鈕回到未填狀態');

  // ── 13. 加床:只有包房才能超過床位數 ──
  await pickRoom('Intertidal Bunk');
  w.changeGuests(5);
  ok(w.guests === 2, '沒包房 → 人數上限 2 (實際 ' + w.guests + ')');
  $('whole-room-check').checked = true;
  $('whole-room-check').dispatchEvent(new w.Event('change'));
  w.changeGuests(5);
  ok(w.guests === 4, '包房 → 可加床到 4 人 (實際 ' + w.guests + ')');
  ok(w.bedsNeeded() === 2, '加床不會多占床位,還是整間 2 張床');
  $('whole-room-check').checked = false;
  $('whole-room-check').dispatchEvent(new w.Event('change'));
  ok(w.guests === 2, '取消包房 → 人數壓回 2 (實際 ' + w.guests + ')');
  ok(doc.querySelectorAll('#companions-list .comp-row').length === 1,
     '同行旅客欄位跟著縮回 1 列');

  // ── 14. nightsOf:退房日不算 ──
  ok(JSON.stringify(w.nightsOf('2026-08-15', '2026-08-18')) ===
     JSON.stringify(['2026-08-15', '2026-08-16', '2026-08-17']), '3 晚 → 不含退房日');
  ok(w.nightsOf('2026-08-15', '2026-08-15').length === 0, '同日進出 → 0 晚');
  ok(JSON.stringify(w.nightsOf('2026-12-31', '2027-01-02')) ===
     JSON.stringify(['2026-12-31', '2027-01-01']), '跨年正確');
  ok(w.nightsOf('', '2026-08-18').length === 0, '沒選日期 → 空陣列');

  console.log(fails ? `\n${fails} 項失敗` : '\n全部通過');
  process.exit(fails ? 1 : 0);
})();
