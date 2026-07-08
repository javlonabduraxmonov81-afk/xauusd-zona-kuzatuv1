// XAUUSD zona kuzatuv — Cloudflare Worker
// Har 15 daqiqada H4 zonalarni tekshiradi va Todoist orqali xabar yuboradi.
// Tuzatishlar: (1) OPEN_TRADES bo'sh; (2) zona xabari BIR MARTA;
// (3) narx zonadan uzoqlashsa flag tiklanadi (rearm) -> qaytganda yana bir marta.

const ZONES = [
  4273.28, 4269.58, 4214.20, 4208.16, 4191.53, 4190.01,
  4178.72, 4176.19, 4125.19, 4120.72, 4109.23, 4105.80,
  4090.58, 4082.96
];
const THRESHOLD = 3;   // zonaga yaqinlik (narx punkti)
const SL_MAX_KUN = 2;  // kunlik maksimal SL soni

// Ochiq bitimlar (SL/TP tegsa bir marta xabar). Hozir yo'q.
const OPEN_TRADES = [];

// Kutilayotgan limit order
const PENDING_LIMIT = { ticket: "2154810504", direction: "SELL", price: 4165.87, sl: 4181.03, tp: 4129.15 };

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkZones(env));
  },
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/sl") {
      const r = await registerSL(env);
      return new Response(JSON.stringify(r, null, 2), { headers: { "content-type": "application/json" } });
    }
    const result = await checkZones(env);
    return new Response(JSON.stringify(result, null, 2), { headers: { "content-type": "application/json" } });
  }
};

async function checkZones(env) {
  let price;
  try {
    price = await fetchGoldPrice(env);
  } catch (e) {
    console.error("Narx olishda xato:", e);
    return { price: null, note: "Narx API xatosi" };
  }

  // Ochiq bitimlar (SL/TP) — bir martalik xabar
  let tradeAlert = null;
  for (const t of OPEN_TRADES) {
    const h = await checkTrade(env, price, t);
    if (h) tradeAlert = h;
  }
  if (tradeAlert) return { price, trade: tradeAlert };

  // 2 SL bo'lgan kun — signallar o'chirilgan
  const bugun = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
  if (env.ZONE_STATE) {
    const blok = await env.ZONE_STATE.get("sl:blok:" + bugun);
    if (blok) return { price, note: "KUN YOPIQ (2 SL) - signallar ochirilgan" };
  }

  // Limit order — bir martalik xabar
  const limitAlert = await checkLimit(env, price);
  if (limitAlert) return { price, limit: limitAlert };

  // Zonalar: har zona uchun BIR MARTA xabar; narx uzoqlashsa flag tiklanadi (rearm)
  let alerted = null;
  for (const zone of ZONES) {
    const dist = Math.abs(price - zone);
    const key = `zone:${zone}`;
    if (dist <= THRESHOLD) {
      if (alerted === null) {
        if (env.ZONE_STATE) {
          const done = await env.ZONE_STATE.get(key);
          if (!done) {
            await env.ZONE_STATE.put(key, "1", { expirationTtl: 86400 });
            await sendTodoist(env, price, zone);
            alerted = zone;
          }
        } else {
          await sendTodoist(env, price, zone);
          alerted = zone;
        }
      }
    } else if (dist > THRESHOLD * 2 && env.ZONE_STATE) {
      // narx zonadan uzoqlashdi -> flagni tozalash (keyingi kelishda yana bir marta xabar)
      const done = await env.ZONE_STATE.get(key);
      if (done) await env.ZONE_STATE.delete(key);
    }
  }
  if (alerted !== null) return { price, alerted, note: `Ogohlantirildi: ${alerted} zona (bir marta)` };
  return { price, note: "Hech qaysi zonaga yaqin emas yoki allaqachon ogohlantirilgan" };
}

async function checkTrade(env, price, t) {
  if (!t) return null;
  const key = `trade:${t.ticket}`;
  if (env.ZONE_STATE) {
    const done = await env.ZONE_STATE.get(key);
    if (done) return null;
  }
  let hit = null;
  if (t.direction === "BUY") {
    if (price <= t.sl) hit = "SL";
    else if (price >= t.tp) hit = "TP";
  } else {
    if (price >= t.sl) hit = "SL";
    else if (price <= t.tp) hit = "TP";
  }
  if (!hit) return null;
  if (env.ZONE_STATE) await env.ZONE_STATE.put(key, "1");
  const vaqt = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Tashkent", hour: "2-digit", minute: "2-digit" });
  const emoji = hit === "TP" ? "TP OLINDI!" : "SL OLINDI!";
  await todoistPost(env, `[${vaqt}] ${emoji} Ticket ${t.ticket} narx ${price}. SL=${t.sl}, TP=${t.tp}. Bitim holatini tekshir.`);
  return hit;
}

async function checkLimit(env, price) {
  if (!PENDING_LIMIT) return null;
  const key = "limit:" + PENDING_LIMIT.price;
  if (env.ZONE_STATE) {
    const done = await env.ZONE_STATE.get(key);
    if (done) return null;
  }
  const tegdi = PENDING_LIMIT.direction === "BUY" ? price <= PENDING_LIMIT.price : price >= PENDING_LIMIT.price;
  if (!tegdi) return null;
  if (env.ZONE_STATE) await env.ZONE_STATE.put(key, "1", { expirationTtl: 172800 });
  await todoistXabar(env, "LIMIT TOLDI! " + PENDING_LIMIT.direction + " " + PENDING_LIMIT.price + " (hozirgi narx " + price + "). MT5 da tekshir, OPEN_TRADE ni yangilat.");
  return PENDING_LIMIT.price;
}

async function registerSL(env) {
  const bugun = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tashkent" });
  const key = "sl:kun:" + bugun;
  let soni = 1;
  if (env.ZONE_STATE) {
    soni = (parseInt(await env.ZONE_STATE.get(key)) || 0) + 1;
    await env.ZONE_STATE.put(key, String(soni), { expirationTtl: 86400 });
  }
  if (soni >= SL_MAX_KUN) {
    if (env.ZONE_STATE) await env.ZONE_STATE.put("sl:blok:" + bugun, "1", { expirationTtl: 86400 });
    await todoistXabar(env, soni + "-SL - KUN TUGADI (#20 qoida). Monitorni YOP. Zona signallari ertagacha ochirildi.");
  } else {
    await todoistXabar(env, "1-SL qayd etildi. 20 DAQIQA hech narsa ochma (#10 qoida). Yana SL bolsa kun yopiladi.");
  }
  return { bugun, slSoni: soni, kunYopiq: soni >= SL_MAX_KUN };
}

async function todoistXabar(env, matn) {
  const vaqt = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Tashkent", hour: "2-digit", minute: "2-digit" });
  await todoistPost(env, "[" + vaqt + "] " + matn);
}

async function todoistPost(env, content) {
  const resp = await fetch("https://api.todoist.com/api/v1/tasks", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.TODOIST_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ content, due_string: "in 1 minute", priority: 4 })
  });
  if (!resp.ok) console.error("Todoist xato:", resp.status);
}

async function fetchGoldPrice(env) {
  const resp = await fetch(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${env.TWELVE_KEY}`);
  if (!resp.ok) throw new Error(`TwelveData xato: ${resp.status}`);
  const data = await resp.json();
  if (!data.price) throw new Error(`TwelveData javob xato: ${data.message ?? "narx yo'q"}`);
  return parseFloat(data.price);
}

async function sendTodoist(env, price, zone) {
  const vaqt = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Tashkent", hour: "2-digit", minute: "2-digit" });
  const content = `[${vaqt}] ⚡ XAUUSD narx ${price} — ${zone} H4 zonasiga yaqin! CHECKLIST (hammasi HA bolsa kirasan): 1) Zona 50-100 sham ichidami? 2) M15 tasdiq (engulfing/kill/Eiffel) bormi? 3) RR 1:3+ mi? 4) Bugun SL nechta - 2 bolsa STOP! 5) FAQAT LIMIT order - market taqiq!`;
  await todoistPost(env, content);
}
