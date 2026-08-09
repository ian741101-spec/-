// Cloudflare Worker — in.house Airtable Proxy
// =============================================
// Secrets (Cloudflare Dashboard → Settings → Variables):
//   AIRTABLE_TOKEN  — pat... 開頭的 Personal Access Token
//
// 路由總覽：
//   GET  /availability?room_type=xxx        → 查詢封鎖日期
//   POST /booking                           → 建立新訂單（自動產生 booking_code）
//   GET  /checkin/verify?code=xxx&phone4=xx → 驗證訂單 + 手機後四碼
//   POST /checkin/submit                    → 提交 check-in + 回傳該房固定門鎖密碼
//   GET  /auth/me                           → 會員資料+點數+訂房+兌換紀錄
//   POST /member/birthday                   → 設定生日月份
//   POST /member/redeem                     → 點數兌換申請
//   GET  /health                            → 健康檢查
//
// members 表:line_user_id, display_name, picture_url, points(棄用,改即時計算),
//            created_at, birthday_month(1-12), points_adjust(手動加減點)
// redemptions 表:line_user_id, member_name, item, label, points_cost,
//            status(Pending/Approved/Used/Rejected), coupon_code, created_at, expires_at
//
// Airtable 欄位清單（15個，無重複）：
//   訂房：booking_code, guest_name, guest_phone, guest_email,
//         room_type, checkin_date, checkout_date, guests, notes, status
//   Check-in：checkin_status, arrival_time, transport, lock_code, checkin_at
// rooms 表（每房固定密碼，硬體不聯網、密碼人工設定於鎖上）：
//   room_type（需與訂房表 room_type 完全一致）, lock_code

const AIRTABLE_BASE    = 'app8ObqmBPie5o3WJ';
const AIRTABLE_TABLE   = 'tblVoUuOMnrZW0b1d';
const AIRTABLE_ROOMS   = 'rooms';
const AIRTABLE_MEMBERS = 'members';

// LINE Login(secrets:LINE_CHANNEL_SECRET、SESSION_SECRET)
const LINE_CHANNEL_ID = '2010742540';
const SITE_URL        = 'https://inhouse-dcc.pages.dev';

// ── 住宿集點規則(2026-08 海報版)──
// 每晚計點:Intertidal Bunk 1 點,其餘房型 2 點
// 加倍(擇優不疊加):11–4 月的週一~週四晚 ×2;生日當月 ×2(需會員填 birthday_month)
// 入點時機:完成入住(checkin_status = Checked-in 且 status != Cancelled)
// 點數 = 累積(訂房計算) + points_adjust(members 表手動調整,推薦好友等) − 已兌換
const AIRTABLE_REDEMPTIONS = 'redemptions';
const ROOM_POINTS_DEFAULT  = 2;
const ROOM_POINTS          = { 'Intertidal Bunk': 1 };
const REWARDS = {
  gift10:    { cost: 10, label: '小禮物或飲品' },
  coupon300: { cost: 20, label: 'NT$300 住宿折價券' },
  coupon500: { cost: 40, label: 'NT$500 住宿折價券' },
  upgrade:   { cost: 40, label: '房型升等(依房況)' },
};

const MEMBERS_API     = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_MEMBERS}`;
const BOOKINGS_API    = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`;
const REDEMPTIONS_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_REDEMPTIONS}`;

function atGet(apiUrl, token) {
  return fetch(apiUrl, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
}

// 單筆訂單可得點數(逐晚計算,含加倍;90 晚上限防呆)
function bookingPoints(f, birthdayMonth) {
  if (!f.checkin_date || !f.checkout_date) return 0;
  const start = new Date(f.checkin_date + 'T00:00:00Z');
  const end   = new Date(f.checkout_date + 'T00:00:00Z');
  if (isNaN(start) || isNaN(end) || end <= start) return 0;
  const base = ROOM_POINTS[f.room_type] !== undefined ? ROOM_POINTS[f.room_type] : ROOM_POINTS_DEFAULT;
  let total = 0, n = 0;
  for (const d = new Date(start); d < end && n < 90; d.setUTCDate(d.getUTCDate() + 1), n++) {
    const m  = d.getUTCMonth() + 1;
    const dw = d.getUTCDay();
    const weekdayDouble  = (m >= 11 || m <= 4) && dw >= 1 && dw <= 4;
    const birthdayDouble = !!birthdayMonth && m === birthdayMonth;
    total += base * ((weekdayDouble || birthdayDouble) ? 2 : 1);
  }
  return total;
}
function bookingCounted(f) {
  return f.status !== 'Cancelled' && f.checkin_status === 'Checked-in';
}

// 會員總覽:會員記錄 + 訂房(含每筆點數)+ 兌換紀錄 + 點數結算
async function loadMemberData(sub, TOKEN) {
  const filter = encodeURIComponent(`{line_user_id}="${sub}"`);

  let memberRec = null;
  try {
    const found = await atGet(`${MEMBERS_API}?filterByFormula=${filter}&maxRecords=1`, TOKEN);
    if (found.records && found.records.length > 0) memberRec = found.records[0];
  } catch (_) {}
  const mf = memberRec ? memberRec.fields : {};
  const birthdayMonth = Number(mf.birthday_month) >= 1 && Number(mf.birthday_month) <= 12
    ? Number(mf.birthday_month) : null;
  const adjust = Number(mf.points_adjust) || 0;

  let earned = 0;
  let bookings = [];
  try {
    const bRes = await atGet(`${BOOKINGS_API}?filterByFormula=${filter}&sort%5B0%5D%5Bfield%5D=checkin_date&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=100`, TOKEN);
    if (bRes.records) {
      bookings = bRes.records.map(r => {
        const f = r.fields;
        const pts     = bookingPoints(f, birthdayMonth);
        const counted = bookingCounted(f);
        if (counted) earned += pts;
        return {
          code:     f.booking_code   || '',
          room:     f.room_type      || '',
          checkin:  f.checkin_date   || '',
          checkout: f.checkout_date  || '',
          guests:   f.guests         || 1,
          status:   f.status         || '',
          checkinStatus: f.checkin_status || '',
          points:   pts,
          counted,
        };
      });
    }
  } catch (_) {}

  let redeemed = 0;
  let redemptions = [];
  try {
    const rRes = await atGet(`${REDEMPTIONS_API}?filterByFormula=${filter}&maxRecords=100`, TOKEN);
    if (rRes.records) {
      redemptions = rRes.records.map(r => {
        const f = r.fields;
        const cost = Number(f.points_cost) || 0;
        if (f.status !== 'Rejected') redeemed += cost;   // 退回的兌換不扣點
        return {
          item:    f.item        || '',
          label:   f.label       || '',
          cost,
          status:  f.status      || 'Pending',
          code:    f.coupon_code || '',
          expires: f.expires_at  || '',
          created: f.created_at  || '',
        };
      }).sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    }
  } catch (_) {}

  return {
    memberRec, birthdayMonth, bookings, redemptions,
    points: { earned, adjust, redeemed, available: earned + adjust - redeemed },
  };
}

// ── 簽章工具(HMAC-SHA256,無狀態 token)──
const te = new TextEncoder();
function b64u(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64uJson(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64uParse(s) {
  try { return JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g,'+').replace(/_/g,'/'))))); }
  catch (_) { return null; }
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, te.encode(data)));
}
async function makeToken(payload, secret) {
  const p = b64uJson(payload);
  return `${p}.${await hmac(secret, p)}`;
}
async function verifyToken(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [p, sig] = token.split('.');
  if (sig !== await hmac(secret, p)) return null;
  const payload = b64uParse(p);
  if (!payload || (payload.exp && Date.now() > payload.exp)) return null;
  return payload;
}
async function memberFromRequest(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  return verifyToken(auth.slice(7), env.SESSION_SECRET);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request, env, ctx) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const TOKEN     = env.AIRTABLE_TOKEN;
    const BASE_URL  = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`;
    const ROOMS_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_ROOMS}`;
    const url      = new URL(request.url);

    // ── GET /health ──
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, ts: Date.now() });
    }

    const MEMBERS_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_MEMBERS}`;

    // ── GET /auth/line/login → 導向 LINE 授權頁 ──
    if (request.method === 'GET' && url.pathname === '/auth/line/login') {
      const state = await makeToken({ t: Date.now() }, env.SESSION_SECRET);
      const authorize = 'https://access.line.me/oauth2/v2.1/authorize'
        + '?response_type=code'
        + `&client_id=${LINE_CHANNEL_ID}`
        + `&redirect_uri=${encodeURIComponent(url.origin + '/auth/line/callback')}`
        + `&state=${encodeURIComponent(state)}`
        + `&scope=${encodeURIComponent('profile openid')}`
        + '&bot_prompt=normal';   // 官方帳號連結後,登入頁會出現「加入好友」選項
      return Response.redirect(authorize, 302);
    }

    // ── GET /auth/line/callback → 換 token、抓 profile、upsert 會員、發 session ──
    if (request.method === 'GET' && url.pathname === '/auth/line/callback') {
      try {
        const code  = url.searchParams.get('code');
        const state = await verifyToken(url.searchParams.get('state') || '', env.SESSION_SECRET);
        if (!code || !state || Date.now() - state.t > 10 * 60 * 1000) {
          return Response.redirect(`${SITE_URL}/member?error=state`, 302);
        }
        const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type:    'authorization_code',
            code,
            redirect_uri:  url.origin + '/auth/line/callback',
            client_id:     LINE_CHANNEL_ID,
            client_secret: env.LINE_CHANNEL_SECRET,
          }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) return Response.redirect(`${SITE_URL}/member?error=token`, 302);

        const profRes = await fetch('https://api.line.me/v2/profile', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const prof = await profRes.json();
        if (!prof.userId) return Response.redirect(`${SITE_URL}/member?error=profile`, 302);

        // upsert 會員(members 表尚未建立時不擋登入)
        try {
          const filter = `{line_user_id}="${prof.userId}"`;
          const found  = await fetch(`${MEMBERS_URL}?filterByFormula=${encodeURIComponent(filter)}&maxRecords=1`, {
            headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` },
          }).then(r => r.json());
          if (found.records && found.records.length > 0) {
            await fetch(`${MEMBERS_URL}/${found.records[0].id}`, {
              method: 'PATCH',
              headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ fields: { display_name: prof.displayName || '', picture_url: prof.pictureUrl || '' } }),
            });
          } else if (!found.error) {
            await fetch(MEMBERS_URL, {
              method: 'POST',
              headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ fields: {
                line_user_id: prof.userId,
                display_name: prof.displayName || '',
                picture_url:  prof.pictureUrl || '',
                points:       0,
                created_at:   new Date().toISOString().slice(0, 10),
              } }),
            });
          }
        } catch (_) {}

        const session = await makeToken({
          sub:  prof.userId,
          name: prof.displayName || '',
          pic:  prof.pictureUrl || '',
          exp:  Date.now() + 30 * 24 * 60 * 60 * 1000,
        }, env.SESSION_SECRET);
        return Response.redirect(`${SITE_URL}/member#token=${session}`, 302);
      } catch (e) {
        return Response.redirect(`${SITE_URL}/member?error=server`, 302);
      }
    }

    // ── GET /auth/me → 會員資料 + 點數結算 + 訂房紀錄 + 兌換紀錄 ──
    if (request.method === 'GET' && url.pathname === '/auth/me') {
      const session = await memberFromRequest(request, env);
      if (!session) return json({ error: 'unauthorized' }, 401);

      const data = await loadMemberData(session.sub, TOKEN);
      const mf   = data.memberRec ? data.memberRec.fields : {};
      return json({
        ok: true,
        member: {
          display_name:   mf.display_name || session.name,
          picture_url:    mf.picture_url  || session.pic,
          birthday_month: data.birthdayMonth,
          points:         data.points,
        },
        bookings:    data.bookings,
        redemptions: data.redemptions,
      });
    }

    // ── POST /member/birthday → 設定生日月份(當月入住點數雙倍)──
    if (request.method === 'POST' && url.pathname === '/member/birthday') {
      const session = await memberFromRequest(request, env);
      if (!session) return json({ error: 'unauthorized' }, 401);
      try {
        const body  = await request.json();
        const month = Number(body.month);
        if (!(month >= 1 && month <= 12)) return json({ ok: false, error: 'month 需為 1-12' }, 400);

        const filter = encodeURIComponent(`{line_user_id}="${session.sub}"`);
        const found  = await atGet(`${MEMBERS_API}?filterByFormula=${filter}&maxRecords=1`, TOKEN);
        if (!found.records || found.records.length === 0) {
          return json({ ok: false, error: '會員資料不存在,請重新登入' }, 404);
        }
        const res = await fetch(`${MEMBERS_API}/${found.records[0].id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { birthday_month: month } }),
        });
        const data = await res.json();
        if (data.error) {
          const msg = /UNKNOWN_FIELD_NAME/i.test(JSON.stringify(data.error))
            ? 'members 表缺少 birthday_month 欄位,請先到 Airtable 新增'
            : JSON.stringify(data.error);
          return json({ ok: false, error: msg }, 502);
        }
        return json({ ok: true, birthday_month: month });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── POST /member/redeem → 點數兌換申請(點數即扣,店家於 Airtable 核准)──
    // Body: { item: gift10 | coupon300 | coupon500 | upgrade }
    if (request.method === 'POST' && url.pathname === '/member/redeem') {
      const session = await memberFromRequest(request, env);
      if (!session) return json({ error: 'unauthorized' }, 401);
      try {
        const body   = await request.json();
        const reward = REWARDS[body.item];
        if (!reward) return json({ ok: false, error: '無效的兌換項目' }, 400);

        const data = await loadMemberData(session.sub, TOKEN);
        if (data.points.available < reward.cost) {
          return json({ ok: false, error: 'points', available: data.points.available }, 400);
        }

        const code    = 'IH-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        const expires = new Date();
        expires.setUTCMonth(expires.getUTCMonth() + 6);   // 效期 6 個月
        const res = await fetch(REDEMPTIONS_API, {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            typecast: true,
            fields: {
              line_user_id: session.sub,
              member_name:  session.name || '',
              item:         body.item,
              label:        reward.label,
              points_cost:  reward.cost,
              status:       'Pending',
              coupon_code:  code,
              created_at:   new Date().toISOString().slice(0, 10),
              expires_at:   expires.toISOString().slice(0, 10),
            },
          }),
        });
        const created = await res.json();
        if (created.error) {
          const msg = /NOT_FOUND|TABLE_NOT_FOUND/i.test(JSON.stringify(created.error))
            ? 'redemptions 表尚未建立,請先到 Airtable 新增'
            : JSON.stringify(created.error);
          return json({ ok: false, error: msg }, 502);
        }
        return json({ ok: true, code, remaining: data.points.available - reward.cost });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── GET /availability?room_type=xxx ──
    if (request.method === 'GET' && url.pathname === '/availability') {
      const room   = url.searchParams.get('room_type') || '';
      const filter = `AND({room_type}="${room}",{status}!="Cancelled")`;
      const apiUrl = `${BASE_URL}?filterByFormula=${encodeURIComponent(filter)}&fields[]=checkin_date&fields[]=checkout_date`;

      try {
        const res  = await fetch(apiUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
        const data = await res.json();
        if (data.error) return json({ blocked: [], error: data.error });

        const blocked = [];
        for (const rec of (data.records || [])) {
          const { checkin_date, checkout_date } = rec.fields;
          if (!checkin_date || !checkout_date) continue;
          const start = new Date(checkin_date);
          const end   = new Date(checkout_date);
          for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
            blocked.push(d.toISOString().slice(0, 10));
          }
        }
        return json({ blocked });
      } catch (e) {
        return json({ blocked: [], error: e.message });
      }
    }

    // ── POST /booking ──
    if (request.method === 'POST' && url.pathname === '/booking') {
      try {
        const body   = await request.json();
        const fields = {
          booking_code:  generateBookingCode(body.checkin_date || ''),
          guest_name:    String(body.guest_name  || '').trim(),
          guest_phone:   String(body.guest_phone || '').trim(),
          guest_email:   String(body.guest_email || '').trim(),
          room_type:     String(body.room_type   || '').trim(),
          checkin_date:  String(body.checkin_date  || '').trim(),
          checkout_date: String(body.checkout_date || '').trim(),
          guests:        Number(body.guests) || 1,
          notes:         String(body.notes   || '').trim(),
          status:        'Pending',
        };

        // 會員登入時綁定 LINE 使用者(bookings 表需有 line_user_id 欄位;沒有就自動退回不綁)
        const session = await memberFromRequest(request, env);
        if (session) fields.line_user_id = session.sub;

        let res  = await fetch(BASE_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields })
        });
        let data = await res.json();

        if (data.error && fields.line_user_id && /UNKNOWN_FIELD_NAME/i.test(JSON.stringify(data.error))) {
          delete fields.line_user_id;
          res  = await fetch(BASE_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields })
          });
          data = await res.json();
        }

        if (data.error) return json({ ok: false, error: data.error }, 400);

        // LINE 推播通知(業主必發;房客有 LINE 登入才發)。失敗不影響訂房
        ctx.waitUntil(notifyBookingViaLine(env, fields, session, String(body.lang || 'zh')));

        return json({ ok: true, id: data.id, booking_code: fields.booking_code });

      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── GET /checkin/verify?code=IH-xxx&phone4=1234 ──
    if (request.method === 'GET' && url.pathname === '/checkin/verify') {
      const code   = (url.searchParams.get('code')   || '').trim().toUpperCase();
      const phone4 = (url.searchParams.get('phone4') || '').trim();

      if (!code || phone4.length !== 4) {
        return json({ error: '請提供訂單編號與手機後四碼' }, 400);
      }

      const filter = `{booking_code}="${code}"`;
      const apiUrl = `${BASE_URL}?filterByFormula=${encodeURIComponent(filter)}&maxRecords=1`;

      try {
        const res  = await fetch(apiUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
        const data = await res.json();

        if (data.error) return json({ error: 'Airtable 查詢失敗：' + JSON.stringify(data.error) }, 502);
        if (!data.records || data.records.length === 0) {
          return json({ error: '找不到此訂單，請確認編號是否正確' }, 404);
        }

        const rec    = data.records[0];
        const fields = rec.fields;

        // 比對手機後四碼
        const phone  = String(fields.guest_phone || '').replace(/\D/g, '');
        const last4  = phone.slice(-4);
        if (last4 !== phone4) {
          return json({ error: '手機號碼驗證失敗，請確認後四碼' }, 401);
        }

        if (fields.status === 'Cancelled') {
          return json({ error: '此訂單已取消，無法辦理入住' }, 403);
        }

        return json({
          ok: true,
          recordId: rec.id,
          booking: {
            code:      code,
            room:      fields.room_type    || '—',
            checkin:   fields.checkin_date  || '',
            checkout:  fields.checkout_date || '',
            guests:    fields.guests        || 1,
            status:    fields.status        || 'Confirmed',
            guestName: fields.guest_name    || '',
          }
        });

      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── POST /checkin/submit ──
    // Body: { recordId, name, phone, arrivalTime, transport?, note? }
    if (request.method === 'POST' && url.pathname === '/checkin/submit') {
      try {
        const body = await request.json();
        const { recordId, name, phone, arrivalTime } = body;

        if (!recordId || !name || !phone || !arrivalTime) {
          return json({ error: '缺少必填欄位：recordId, name, phone, arrivalTime' }, 400);
        }

        // 依訂單房型查 rooms 表的固定門鎖密碼；查不到不擋 check-in，lockCode 為 null
        let lockCode = null;
        try {
          const bookingRes  = await fetch(`${BASE_URL}/${recordId}`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
          });
          const bookingData = await bookingRes.json();
          const roomType    = bookingData.fields && bookingData.fields.room_type;
          if (roomType) {
            const roomFilter = `{room_type}="${roomType}"`;
            const roomRes  = await fetch(`${ROOMS_URL}?filterByFormula=${encodeURIComponent(roomFilter)}&maxRecords=1`, {
              headers: { Authorization: `Bearer ${TOKEN}` },
            });
            const roomData = await roomRes.json();
            if (roomData.records && roomData.records.length > 0) {
              lockCode = roomData.records[0].fields.lock_code || null;
            }
          }
        } catch (_) {}

        const patchFields = {
          guest_name:     name,
          checkin_status: 'Checked-in',
          arrival_time:   arrivalTime,
          transport:      body.transport || '',
          notes:          body.note ? body.note : undefined,
          lock_code:      lockCode || undefined,
          checkin_at:     new Date().toISOString().slice(0, 10),
          status:         'Confirmed',
        };

        // 移除 undefined 欄位（note 為空時不覆蓋原有 notes）
        Object.keys(patchFields).forEach(k => {
          if (patchFields[k] === undefined) delete patchFields[k];
        });

        const patchUrl = `${BASE_URL}/${recordId}`;
        const res = await fetch(patchUrl, {
          method: 'PATCH',
          headers: {
            Authorization:  `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fields: patchFields }),
        });
        const data = await res.json();

        if (data.error) return json({ ok: false, error: data.error }, 502);
        return json({ ok: true, lockCode });

      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    return new Response('Not found', { status: 404, headers: CORS });
  }
};

// ── 產生訂單編號：IH-YYYYMMDD-NNN ──
// ── LINE Messaging API 推播 ──
// 需要 Worker secrets:LINE_MESSAGING_TOKEN(channel access token)、OWNER_LINE_USER_ID
// Messaging API channel 必須與 LINE Login channel 同一個 provider,userId 才會一致
async function linePush(env, to, text) {
  if (!env.LINE_MESSAGING_TOKEN || !to) return;
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.LINE_MESSAGING_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok) console.error('LINE push failed:', res.status, await res.text());
  } catch (e) {
    console.error('LINE push error:', e.message);
  }
}

async function notifyBookingViaLine(env, f, session, lang) {
  const ownerText = [
    '🔔 新訂房申請',
    `訂單編號:${f.booking_code}`,
    `房型:${f.room_type}`,
    `入住:${f.checkin_date} → 退房:${f.checkout_date}`,
    `人數:${f.guests}`,
    `姓名:${f.guest_name}`,
    `電話:${f.guest_phone}`,
    f.guest_email ? `Email:${f.guest_email}` : null,
    f.notes ? `備註:${f.notes}` : null,
    session ? '(房客為 LINE 會員,已同步發送確認訊息)' : null,
  ].filter(Boolean).join('\n');

  const guestTexts = {
    zh: [
      '🌊 in.house 已收到您的訂房申請',
      `訂單編號:${f.booking_code}`,
      `房型:${f.room_type}`,
      `入住:${f.checkin_date} → 退房:${f.checkout_date}`,
      `人數:${f.guests}`,
      '',
      '我們確認房況後會盡快與您聯繫。',
      '自助入住時需要「訂單編號 + 手機後四碼」,請妥善保存這則訊息。',
    ],
    en: [
      '🌊 in.house — booking request received',
      `Booking code: ${f.booking_code}`,
      `Room: ${f.room_type}`,
      `Check-in: ${f.checkin_date} → Check-out: ${f.checkout_date}`,
      `Guests: ${f.guests}`,
      '',
      'We will confirm availability and get back to you shortly.',
      'Self check-in requires your booking code + last 4 digits of your phone number — please keep this message.',
    ],
    ja: [
      '🌊 in.house ご予約リクエストを受け付けました',
      `予約番号:${f.booking_code}`,
      `お部屋:${f.room_type}`,
      `チェックイン:${f.checkin_date} → チェックアウト:${f.checkout_date}`,
      `人数:${f.guests}`,
      '',
      '空室状況を確認のうえ、追ってご連絡いたします。',
      'セルフチェックインには「予約番号+電話番号下4桁」が必要です。このメッセージを保存してください。',
    ],
  };
  const guestText = (guestTexts[lang] || guestTexts.zh).join('\n');

  await Promise.all([
    linePush(env, env.OWNER_LINE_USER_ID, ownerText),
    session ? linePush(env, session.sub, guestText) : Promise.resolve(),
  ]);
}

function generateBookingCode(checkinDate) {
  const d   = checkinDate ? checkinDate.replace(/-/g, '') : new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seq = String(Math.floor(Math.random() * 900) + 100);
  return `IH-${d}-${seq}`;
}
