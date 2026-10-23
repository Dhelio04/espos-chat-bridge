/**
 * EspOS EspCHAT Cloud Bridge v2.1.0 - Full History, Real Contacts & Avatars
 * Compatible con Render 24/7 y One UI 8
 */
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require("@whiskeysockets/baileys");
const pino = require("pino");
const http = require("http");
const url = require("url");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const authFolder = path.join(__dirname, "auth_info_baileys");

let sock = null;
let isConnected = false;
let myNumber = "";
let myName = "";
let currentQR = "";
let chatsCache = new Map();
let messagesCache = new Map();
let contactsMap = new Map(); // Agenda telefónica real (JID -> Nombre guardado)
let callsList = [];

function extraerTexto(raw) {
  if (!raw) return "";
  let m = raw;
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
  if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
  if (m.editedMessage?.message?.protocolMessage?.editedMessage) {
    m = m.editedMessage.message.protocolMessage.editedMessage;
  }
  if (!m) return "";
  if (m.conversation && m.conversation.trim()) return m.conversation.trim();
  if (m.extendedTextMessage?.text && m.extendedTextMessage.text.trim()) return m.extendedTextMessage.text.trim();
  if (m.imageMessage?.caption) return m.imageMessage.caption.trim();
  if (m.videoMessage?.caption) return m.videoMessage.caption.trim();
  if (m.imageMessage) return "[Foto]";
  if (m.audioMessage) return "[Nota de voz]";
  if (m.videoMessage) return "[Video]";
  if (m.documentMessage) return "[Documento: " + (m.documentMessage.fileName || "archivo") + "]";
  if (m.stickerMessage) return "[Sticker]";
  if (m.locationMessage) return "[Ubicación]";
  if (m.contactMessage) return "[Contacto]";
  return "";
}

function resolverNombre(jid, pushName, fromMe) {
  if (!jid) return "Contacto";
  if (myNumber && jid.includes(myNumber) && !jid.endsWith("@g.us")) return "Mensajes Guardados (Tú)";
  
  // 1. Prioridad máxima: Nombre guardado en tu agenda de contactos del teléfono
  const guardado = contactsMap.get(jid);
  if (guardado && guardado !== myName) return guardado;

  // 2. Nombre de perfil que se puso el contacto (pushName)
  if (!fromMe && pushName && pushName !== myName) {
    contactsMap.set(jid, pushName);
    return pushName;
  }

  // 3. Formato legible si no está en contactos
  const base = jid.split("@")[0];
  if (jid.endsWith("@g.us")) return "Comunidad #" + base.slice(0, 6);
  if (jid.endsWith("@lid") || base.length > 12) return "Contacto WA · " + base.slice(-4);
  return "+" + base;
}

function procesarMensaje(msg, esEnVivo = true) {
  if (!msg || !msg.message) return;
  const jid = msg.key?.remoteJid;
  if (!jid || jid.includes("@broadcast") || jid.includes("status@broadcast")) return;

  // Escudo Anti-Delete: detectar revocación de mensajes
  const raw = msg.message;
  const proto = raw.protocolMessage || raw.ephemeralMessage?.message?.protocolMessage;
  if (proto && (proto.type === 0 || proto.key?.id)) {
    const targetId = proto.key?.id;
    if (targetId && messagesCache.has(jid)) {
      const lista = messagesCache.get(jid);
      for (const item of lista) {
        if (item.id === targetId && !item.deleted) {
          item.deleted = true;
          item.text = "[Eliminado] " + item.text;
          if (chatsCache.has(jid)) chatsCache.get(jid).lastMsg = item.text;
          break;
        }
      }
    }
    return;
  }

  const text = extraerTexto(msg.message);
  if (!text) return;

  const fromMe = Boolean(msg.key?.fromMe);
  const rawTs = msg.messageTimestamp;
  const ts = rawTs ? (typeof rawTs === "number" ? rawTs : Number(rawTs.low || rawTs)) : Math.floor(Date.now() / 1000);
  const timeStr = new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (!messagesCache.has(jid)) messagesCache.set(jid, []);
  const hist = messagesCache.get(jid);
  const msgId = msg.key?.id || String(ts);
  if (!hist.some(x => x.id === msgId)) {
    hist.push({ id: msgId, fromMe, deleted: false, text, time: timeStr, ts });
    if (hist.length > 30) hist.shift();
  }

  const name = contactsMap.get(jid) || resolverNombre(jid, msg.pushName, fromMe);
  const prevUnread = chatsCache.has(jid) ? chatsCache.get(jid).unread : 0;
  const unread = fromMe ? 0 : (esEnVivo ? prevUnread + 1 : prevUnread);

  chatsCache.set(jid, {
    id: jid,
    name,
    lastMsg: text,
    time: timeStr,
    unread,
    timestamp: ts
  });
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: true // Pide a WhatsApp los 30 chats y la agenda completa
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      try { currentQR = await QRCode.toDataURL(qr); } catch (e) {}
    }
    if (connection === "close") {
      isConnected = false;
      currentQR = "";
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) setTimeout(startWhatsApp, 3000);
    } else if (connection === "open") {
      isConnected = true;
      currentQR = "";
      myNumber = sock.user?.id ? sock.user.id.split(":")[0] : "";
      myName = sock.user?.name || myNumber;
      console.log(`[EspCHAT Cloud] Conectado como: ${myName} (${myNumber})`);
    }
  });

  // Captura la agenda de contactos telefónica y los 30 chats históricos
  sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
    if (Array.isArray(contacts)) {
      for (const c of contacts) {
        const nom = c.name || c.notify || c.verifiedName;
        if (c.id && nom) contactsMap.set(c.id, nom);
      }
    }
    if (Array.isArray(chats)) {
      for (const c of chats) {
        if (!c.id || c.id.includes("@broadcast") || c.id.includes("status@broadcast")) continue;
        const nom = contactsMap.get(c.id) || c.name || resolverNombre(c.id, "", false);
        if (!chatsCache.has(c.id)) {
          const ts = Number(c.conversationTimestamp?.low || c.conversationTimestamp || 0);
          chatsCache.set(c.id, {
            id: c.id,
            name: nom,
            lastMsg: "Toca para abrir conversación",
            time: ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "",
            unread: c.unreadCount || 0,
            timestamp: ts
          });
        }
      }
    }
    if (Array.isArray(messages)) {
      for (const m of messages) procesarMensaje(m, false);
    }
  });

  const onContacts = (list) => {
    for (const c of list) {
      const nom = c.name || c.notify || c.verifiedName;
      if (c && c.id && nom && nom !== myName) {
        contactsMap.set(c.id, nom);
        if (chatsCache.has(c.id)) chatsCache.get(c.id).name = nom;
      }
    }
  };
  sock.ev.on("contacts.upsert", onContacts);
  sock.ev.on("contacts.update", onContacts);

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) procesarMensaje(msg, true);
  });

  sock.ev.on("call", (callEvents) => {
    for (const ev of callEvents) {
      const cid = ev.from || ev.chatId || "";
      if (!cid) continue;
      const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const name = contactsMap.get(cid) || resolverNombre(cid, "", false);
      callsList.unshift({
        id: cid,
        name,
        time: timeStr,
        missed: ev.status === "reject" || ev.status === "timeout" || ev.status === "offer",
        video: Boolean(ev.isVideo)
      });
      if (callsList.length > 15) callsList.pop();
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

  if (pathname === "/" || pathname === "/qr") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (isConnected) {
      return res.end(`<!DOCTYPE html><html><body style="background:#090d12;color:white;text-align:center;padding:40px;font-family:sans-serif;"><div style="max-width:420px;margin:auto;background:#131b24;border-radius:20px;padding:30px;border:1px solid #25d366;"><h2 style="color:#25d366;">&#10004; CONECTADO 24/7</h2><p>WhatsApp vinculado: <b>${myName}</b> (${myNumber})</p><p>Chats sincronizados: <b>${chatsCache.size}</b></p></div></body></html>`);
    } else if (currentQR) {
      return res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="6"></head><body style="background:#090d12;color:white;text-align:center;padding:40px;font-family:sans-serif;"><div style="max-width:420px;margin:auto;background:#131b24;border-radius:20px;padding:30px;border:1px solid #38bdf8;"><h2>Vincular WhatsApp a EspOS</h2><img src="${currentQR}" style="width:260px;height:260px;background:white;padding:10px;border-radius:12px;"><p>Escanea desde WhatsApp &gt; Dispositivos vinculados</p></div></body></html>`);
    } else {
      return res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3"></head><body style="background:#090d12;color:white;text-align:center;padding:50px;font-family:sans-serif;"><h2>Iniciando EspCHAT Bridge...</h2></body></html>`);
    }
  }

  if (pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ conectado: isConnected, usuario: myName, numero: myNumber, totalChats: chatsCache.size }));
  }

  if (pathname === "/api/chats" && req.method === "GET") {
    const list = Array.from(chatsCache.values())
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, 30); // Devuelve hasta 30 chats ordenados cronológicamente
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ chats: list, llamadas: callsList }));
  }

  if (pathname === "/api/mensajes" && req.method === "GET") {
    const chatJid = parsedUrl.query.chat;
    const msgs = messagesCache.get(chatJid) || [];
    if (chatsCache.has(chatJid)) chatsCache.get(chatJid).unread = 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ chat: chatJid, mensajes: msgs }));
  }

  // Endpoint para fotos de perfil / avatares
  if (pathname === "/api/avatar" && req.method === "GET") {
    const chatJid = parsedUrl.query.chat;
    if (!chatJid || !sock) {
      res.writeHead(400); return res.end();
    }
    try {
      const ppUrl = await sock.profilePictureUrl(chatJid, "image").catch(() => null);
      if (!ppUrl) {
        res.writeHead(404); return res.end();
      }
      const imgRes = await fetch(ppUrl);
      if (!imgRes.ok) {
        res.writeHead(404); return res.end();
      }
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
      res.writeHead(200, {
        "Content-Type": imgRes.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "public, max-age=86400"
      });
      return res.end(imgBuffer);
    } catch (err) {
      res.writeHead(500); return res.end();
    }
  }

  if (pathname === "/api/enviar" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const { chat, texto } = JSON.parse(body);
        await sock.sendMessage(chat, { text: texto });
        const ts = Math.floor(Date.now() / 1000);
        const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        if (!messagesCache.has(chat)) messagesCache.set(chat, []);
        messagesCache.get(chat).push({ id: String(ts), fromMe: true, deleted: false, text: texto, time: timeStr, ts });
        if (chatsCache.has(chat)) {
          chatsCache.get(chat).lastMsg = texto;
          chatsCache.get(chat).time = timeStr;
          chatsCache.get(chat).timestamp = ts;
        }
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
  console.log(`[EspCHAT Bridge v2.1] Activo en puerto ${PORT}`);
  startWhatsApp();
});
