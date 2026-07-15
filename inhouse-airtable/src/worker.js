// Cloudflare Worker — in.house Airtable Proxy
// =============================================
// Secrets (Cloudflare Dashboard → Settings → Variables):
//   AIRTABLE_TOKEN  — pat... 開頭的 Personal Access Token
//
// 路由總覽：
//   GET  /availability?room_type=xxx        → 查詢封鎖日期
//   POST /booking                           → 建立新訂單（自動產生 booking_code）
//   GET  /checkin/verify?code=xxx&phone4=xx → 驗證訂單 + 手機後四碼
//   POST /checkin/submit                    → 提交 check-in + 產生門鎖密碼
//   GET  /health                            → 健康檢查
//
// Airtable 欄位清單（15個，無重複）：
//   訂房：booking_code, guest_name, guest_phone, guest_email,
//         room_type, checkin_date, checkout_date, guests, notes, status
//   Check-in：checkin_status, arrival_time, transport, lock_code, checkin_at

const AIRTABLE_BASE  = 'app8ObqmBPie5o3WJ';
const AIRTABLE_TABLE = 'tblVoUuOMnrZW0b1d';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const TOKEN    = env.AIRTABLE_TOKEN;
    const BASE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`;
    const url      = new URL(request.url);

    // ── GET /health ──
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, ts: Date.now() });
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

        const res  = await fetch(BASE_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields })
        });
        const data = await res.json();

        if (data.error) return json({ ok: false, error: data.error }, 400);
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

        const lockCode = generateLockCode();

        const patchFields = {
          guest_name:     name,
          checkin_status: 'Checked-in',
          arrival_time:   arrivalTime,
          transport:      body.transport || '',
          notes:          body.note ? body.note : undefined,
          lock_code:      lockCode,
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
function generateBookingCode(checkinDate) {
  const d   = checkinDate ? checkinDate.replace(/-/g, '') : new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seq = String(Math.floor(Math.random() * 900) + 100);
  return `IH-${d}-${seq}`;
}

// ── 產生六位門鎖密碼（排除 0/1 避免混淆）──
function generateLockCode() {
  const chars = '23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}