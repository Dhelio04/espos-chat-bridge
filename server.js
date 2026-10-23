/**
 * EspOS EspCHAT Cloud Bridge v2.2.0 - One UI 8 Engine
 * - Sincronizacion completa de historial y 50 chats en orden cronologico estricto.
 * - Mapeo integral de contactos telefonicos y LIDs (@lid -> Nombre real de agenda).
 * - Zona horaria local (America/Lima, UTC-5) con formato 12h AM/PM exacto al movil.
 * - Motor de Avatares One UI 8: conversion nativa en servidor a 42x42 RGB565 (3528 bytes).
 * - Escudo Anti-Delete persistente.
 */
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require("@whiskeysockets/baileys");
const pino = require("pino");
const http = require("http");
const url = require("url");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");

let sharp = null;
try { sharp = require("sharp"); } catch (e) { console.log("[Sharp] No disponible aun, esperando instalacion"); }

const PORT = process.env.PORT || 3000;
const authFolder = path.join(__dirname, "auth_info_baileys");
const avatarsFolder = path.join(__dirname, "avatars_cache");
if (!fs.existsSync(avatarsFolder)) fs.mkdirSync(avatarsFolder, { recursive: true });

let sock = null;
let isConnected = false;
let myNumber = "";
let myName = "";
let currentQR = "";
let chatsCache = new Map();
let messagesCache = new Map();
let contactsMap = new Map(); // JID / LID -> Nombre guardado
let callsList = [];

function formatearHora(ts) {
  if (!ts) return "";
  try {
    return new Date(ts * 1000).toLocaleTimeString("es-PE", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Lima"
    });
  } catch (e) {
    return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}

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
  
  // 1. Agenda de contactos telefonica (incluyendo LIDs mapeados)
  const guardado = contactsMap.get(jid);
  if (guardado && guardado !== myName && !guardado.startsWith("Contacto WA")) return guardado;

  // 2. Nombre de perfil asignado por el emisor (pushName)
  if (!fromMe && pushName && pushName !== myName) {
    contactsMap.set(jid, pushName);
    return pushName;
  }

  // 3. Fallback legible
  const base = jid.split("@")[0];
  if (jid.endsWith("@g.us")) return "Comunidad #" + base.slice(0, 6);
  if (jid.endsWith("@lid") || base.length > 12) return "Contacto WA · " + base.slice(-4);
  return "+" + base;
}

function guardarContacto(c) {
  if (!c) return;
  const nom = c.name || c.notify || c.verifiedName;
  if (!nom || nom === myName) return;
  if (c.id) contactsMap.set(c.id, nom);
  if (c.lid) contactsMap.set(c.lid, nom);
}

function procesarMensaje(msg, esEnVivo = true) {
  if (!msg || !msg.message) return;
  const jid = msg.key?.remoteJid;
  if (!jid || jid.includes("@broadcast") || jid.includes("status@broadcast")) return;

  // Escudo Anti-Delete: detectar revocacion
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
  const timeStr = formatearHora(ts);

  if (!messagesCache.has(jid)) messagesCache.set(jid, []);
  const hist = messagesCache.get(jid);
  const msgId = msg.key?.id || String(ts);
  if (!hist.some(x => x.id === msgId)) {
    hist.push({ id: msgId, fromMe, deleted: false, text, time: timeStr, ts });
    if (hist.length > 30) hist.shift();
  }

  const name = resolverNombre(jid, msg.pushName, fromMe);
  const prevUnread = chatsCache.has(jid) ? chatsCache.get(jid).unread : 0;
  const unread = fromMe ? 0 : (esEnVivo ? prevUnread + 1 : prevUnread);

  // Solo actualizar snippet si este mensaje es igual o mas reciente que el existente
  const prev = chatsCache.get(jid);
  if (!prev || ts >= (prev.timestamp || 0)) {
    chatsCache.set(jid, {
      id: jid,
      name,
      lastMsg: text,
      time: timeStr,
      unread,
      timestamp: ts
    });
  } else if (prev && (!prev.name || prev.name.startsWith("Contacto WA") || prev.name.startsWith("+"))) {
    // Si tenemos un nombre mejor, actualizarlo sin alterar el snippet
    prev.name = name;
  }
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
    syncFullHistory: true
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

  sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
    if (Array.isArray(contacts)) {
      for (const c of contacts) guardarContacto(c);
    }
    if (Array.isArray(chats)) {
      for (const c of chats) {
        if (!c.id || c.id.includes("@broadcast") || c.id.includes("status@broadcast")) continue;
        const nom = contactsMap.get(c.id) || (c.lid ? contactsMap.get(c.lid) : null) || c.name || resolverNombre(c.id, "", false);
        const ts = Number(c.conversationTimestamp?.low || c.conversationTimestamp || 0);
        if (!chatsCache.has(c.id)) {
          chatsCache.set(c.id, {
            id: c.id,
            name: nom,
            lastMsg: "Toca para abrir conversación",
            time: ts ? formatearHora(ts) : "",
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
      guardarContacto(c);
      const nom = c.name || c.notify || c.verifiedName;
      if (c && nom && nom !== myName) {
        if (chatsCache.has(c.id)) chatsCache.get(c.id).name = nom;
        if (c.lid && chatsCache.has(c.lid)) chatsCache.get(c.lid).name = nom;
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
      const timeStr = formatearHora(Math.floor(Date.now() / 1000));
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
      return res.end(`<!DOCTYPE html><html><body style="background:#090d12;color:white;text-align:center;padding:40px;font-family:sans-serif;"><div style="max-width:420px;margin:auto;background:#131b24;border-radius:20px;padding:30px;border:1px solid #25d366;"><h2 style="color:#25d366;">&#10004; CONECTADO 24/7</h2><p>WhatsApp vinculado: <b>${myName}</b> (${myNumber})</p><p>Chats en memoria: <b>${chatsCache.size}</b></p></div></body></html>`);
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
      .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
      .slice(0, 50);
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

  // Endpoint de Avatares One UI: entrega 42x42 RGB565 (3528 bytes) exactos
  if (pathname === "/api/avatar" && req.method === "GET") {
    const chatJid = parsedUrl.query.chat;
    if (!chatJid || !sock) {
      res.writeHead(400); return res.end();
    }
    try {
      const safeId = chatJid.replace(/[^a-zA-Z0-9]/g, "_");
      const rawPath = path.join(avatarsFolder, `${safeId}.raw`);
      
      // 1. Si ya esta en cache de disco del servidor, servirlo de inmediato
      if (fs.existsSync(rawPath)) {
        const rawBuf = fs.readFileSync(rawPath);
        if (rawBuf.length === 42 * 42 * 2) {
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": rawBuf.length,
            "Cache-Control": "public, max-age=604800"
          });
          return res.end(rawBuf);
        }
      }

      // 2. Pedir URL del avatar a WhatsApp
      const ppUrl = await sock.profilePictureUrl(chatJid, "image").catch(() => null);
      if (!ppUrl) {
        res.writeHead(404); return res.end();
      }

      // 3. Descargar imagen desde CDN
      const imgRes = await fetch(ppUrl);
      if (!imgRes.ok) {
        res.writeHead(404); return res.end();
      }
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

      // 4. Si Sharp esta disponible, redimensionar y convertir a RGB565 nativo
      if (sharp) {
        const { data } = await sharp(imgBuffer)
          .resize(42, 42, { fit: "cover" })
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true }); // 42 * 42 * 3 (RGB888)

        const raw565 = Buffer.alloc(42 * 42 * 2);
        for (let i = 0; i < 42 * 42; i++) {
          const r = data[i * 3];
          const g = data[i * 3 + 1];
          const b = data[i * 3 + 2];
          const c565 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
          raw565.writeUInt16LE(c565, i * 2);
        }

        try { fs.writeFileSync(rawPath, raw565); } catch (e) {}

        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": raw565.length,
          "Cache-Control": "public, max-age=604800"
        });
        return res.end(raw565);
      } else {
        // Fallback temporal si Sharp no compilo aun
        res.writeHead(200, {
          "Content-Type": imgRes.headers.get("content-type") || "image/jpeg",
          "Cache-Control": "public, max-age=86400"
        });
        return res.end(imgBuffer);
      }
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
        const timeStr = formatearHora(ts);
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
  console.log(`[EspCHAT Bridge v2.2] Activo en puerto ${PORT}`);
  startWhatsApp();
});
