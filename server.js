/**
 * EspOS EspCHAT Cloud Bridge - Servidor para Render
 */
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const pino = require("pino");
const http = require("http");
const url = require("url");
const QRCode = require("qrcode");
const path = require("path");

const PORT = process.env.PORT || 3000;
let sock = null;
let isConnected = false;
let myNumber = "";
let myName = "";
let currentQR = "";
let chatsCache = new Map();
let messagesCache = new Map();

const authFolder = path.join(__dirname, "auth_info_baileys");

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    browser: ["EspOS microPC", "Chrome", "20.0.04"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        currentQR = await QRCode.toDataURL(qr);
        console.log("[EspCHAT] Nuevo QR listo");
      } catch (err) {
        console.error("Error QR:", err);
      }
    }

    if (connection === "close") {
      isConnected = false;
      currentQR = "";
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(startWhatsApp, 3000);
    } else if (connection === "open") {
      isConnected = true;
      currentQR = "";
      myNumber = sock.user?.id ? sock.user.id.split(":")[0] : "";
      myName = sock.user?.name || myNumber;
      console.log(`[EspCHAT] CONECTADO como: ${myName}`);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid.includes("@broadcast") || jid.includes("status@broadcast")) continue;

      const fromMe = msg.key.fromMe;
      const text = msg.message.conversation ||
                   msg.message.extendedTextMessage?.text ||
                   (msg.message.imageMessage ? "[Foto]" : "") ||
                   (msg.message.audioMessage ? "[Audio]" : "") ||
                   "[Mensaje]";

      const timestamp = msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date();
      const timeStr = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      if (!messagesCache.has(jid)) messagesCache.set(jid, []);
      const history = messagesCache.get(jid);
      history.push({ fromMe, text, time: timeStr });
      if (history.length > 30) history.shift();

      const name = msg.pushName || jid.split('@')[0];
      const unread = chatsCache.has(jid) ? (chatsCache.get(jid).unread + (fromMe ? 0 : 1)) : 1;
      chatsCache.set(jid, { id: jid, name, lastMsg: text, time: timeStr, unread });
      console.log(`[WA] ${fromMe ? 'Yo -> ' : ''}${name}: ${text}`);
    }
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (isConnected) {
      return res.end(`
        <!DOCTYPE html><html><head><title>EspCHAT - Conectado</title><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;text-align:center;padding:40px 20px;}.card{max-width:440px;margin:0 auto;background:#1e293b;border-radius:20px;padding:30px;border:1px solid #334155;}.badge{display:inline-block;background:#10b981;color:white;padding:6px 16px;border-radius:20px;font-weight:bold;margin-bottom:20px;}.url{background:#0f172a;border-radius:12px;padding:12px;font-family:monospace;color:#38bdf8;margin:20px 0;border:1px solid #334155;}</style></head>
        <body><div class="card"><div class="badge">&#10004; CONECTADO 24/7</div><h2>EspCHAT Cloud Bridge</h2><p>WhatsApp vinculado: <b>${myName}</b> (${myNumber})</p><hr style="border:0;border-top:1px solid #334155;margin:20px 0;"><p>URL para tu microPC EspOS:</p><div class="url">https://${req.headers.host}</div></div></body></html>
      `);
    } else if (currentQR) {
      return res.end(`
        <!DOCTYPE html><html><head><title>Vincular EspCHAT</title><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="6">
        <style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;text-align:center;padding:40px 20px;}.card{max-width:440px;margin:0 auto;background:#1e293b;border-radius:20px;padding:30px;border:1px solid #334155;}img{border-radius:12px;width:260px;height:260px;margin:15px 0;background:white;padding:10px;}ol{text-align:left;color:#cbd5e1;font-size:14px;line-height:1.8;}</style></head>
        <body><div class="card"><h2>Vincular WhatsApp</h2><p style="color:#94a3b8;">Escanea este código QR con tu celular:</p><img src="${currentQR}" alt="QR"><ol><li>Abre WhatsApp en tu celular.</li><li>Ajustes &gt; <b>Dispositivos vinculados</b>.</li><li>Toca <b>Vincular un dispositivo</b> y apunta a la pantalla.</li></ol></div></body></html>
      `);
    } else {
      return res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3"><style>body{background:#0f172a;color:white;text-align:center;padding:60px;font-family:sans-serif;}</style></head><body><h2>Iniciando EspCHAT Cloud...</h2><p>Generando código QR, espera 5 segundos...</p></body></html>`);
    }
  }

  if (pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ conectado: isConnected, usuario: myName, numero: myNumber }));
  }

  if (pathname === "/api/chats" && req.method === "GET") {
    const list = Array.from(chatsCache.values()).reverse().slice(0, 20);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ chats: list }));
  }

  if (pathname === "/api/mensajes" && req.method === "GET") {
    const chatJid = parsedUrl.query.chat;
    const msgs = messagesCache.get(chatJid) || [];
    if (chatsCache.has(chatJid)) chatsCache.get(chatJid).unread = 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ chat: chatJid, mensajes: msgs }));
  }

  if (pathname === "/api/enviar" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const { chat, texto } = JSON.parse(body);
        await sock.sendMessage(chat, { text: texto });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "404" }));
});

server.listen(PORT, () => {
  console.log(`[EspCHAT Cloud] Activo en puerto ${PORT}`);
  startWhatsApp();
});
