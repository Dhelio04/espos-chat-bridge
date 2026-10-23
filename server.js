/**
 * EspOS EspCHAT Cloud Bridge v2.3.2 - Real Read Receipts, Strict Anti-Delete & Zero Double-Tap
 * - Sincronizacion en tiempo real con chats.upsert, chats.update y messaging-history.
 * - Desduplicacion inteligente de LIDs y telefonos (@lid <-> @s.whatsapp.net).
 * - Fechas relativas oficiales de WhatsApp (Hoy: 1:33 p.m., Ayer, Dia de semana, Fecha).
 * - Motor de Avatares Nativo One UI: 42x42 RGB565 Little-Endian (3528 bytes) procesado con Sharp.
 * - Escudo Anti-Delete persistente.
 */
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const pino = require("pino");
const http = require("http");
const url = require("url");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");

let sharp = null;
try { sharp = require("sharp"); console.log("[Sharp] Motor de imagenes cargado correctamente"); } catch (e) { console.log("[Sharp] No disponible aun"); }

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
let contactsMap = new Map(); // JID / LID -> Nombre de agenda
let lidToJid = new Map();     // LID -> JID
let jidToLid = new Map();     // JID -> LID
let callsList = [];

function formatearHora(ts) {
  if (!ts) return "";
  try {
    const date = new Date(ts * 1000);
    const ahora = new Date();
    
    const opcionesHora = { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Lima" };
    const opcionesFecha = { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "America/Lima" };
    const opcionesDiaSem = { weekday: "short", timeZone: "America/Lima" };

    const strFechaMsg = date.toLocaleDateString("en-CA", { timeZone: "America/Lima" });
    const strFechaHoy = ahora.toLocaleDateString("en-CA", { timeZone: "America/Lima" });
    
    const dMsg = new Date(strFechaMsg + "T12:00:00Z");
    const dHoy = new Date(strFechaHoy + "T12:00:00Z");
    const diffDias = Math.round((dHoy - dMsg) / (1000 * 60 * 60 * 24));

    if (diffDias === 0) {
      return date.toLocaleTimeString("es-PE", opcionesHora).replace(/\s+/g, " ");
    } else if (diffDias === 1) {
      return "Ayer";
    } else if (diffDias > 1 && diffDias < 7) {
      const dia = date.toLocaleDateString("es-PE", opcionesDiaSem);
      return dia.charAt(0).toUpperCase() + dia.slice(1).replace(".", "");
    } else {
      return date.toLocaleDateString("es-PE", opcionesFecha);
    }
  } catch (e) {
    return "";
  }
}

function formatearHoraMensaje(ts) {
  if (!ts) return "";
  try {
    return new Date(ts * 1000).toLocaleTimeString("es-PE", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Lima"
    }).replace(/\s+/g, " ");
  } catch (e) {
    return "";
  }
}

function extraerTexto(raw) {
  if (!raw) return "";
  const isViewOnce = Boolean(raw.viewOnceMessage || raw.viewOnceMessageV2);
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
  if (m.imageMessage) return isViewOnce ? "[Foto de 1 sola vez]" : (m.imageMessage.caption?.trim() || "[Foto]");
  if (m.audioMessage) return isViewOnce ? "[Audio de 1 sola vez]" : "[Nota de voz]";
  if (m.videoMessage) return isViewOnce ? "[Video de 1 sola vez]" : (m.videoMessage.caption?.trim() || "[Video]");
  if (m.documentMessage) return "[Documento: " + (m.documentMessage.fileName || "archivo") + "]";
  if (m.stickerMessage) return "[Sticker]";
  if (m.locationMessage) return "[Ubicacin]";
  if (m.contactMessage) return "[Contacto]";
  return "";
}

function resolverNombre(jid, pushName, fromMe) {
  if (!jid) return "Contacto";
  if (myNumber && jid.includes(myNumber) && !jid.endsWith("@g.us")) return "Mensajes Guardados (T)";
  
  // 1. Agenda telefonica o LID mapeado
  const guardado = contactsMap.get(jid) || (lidToJid.has(jid) ? contactsMap.get(lidToJid.get(jid)) : null) || (jidToLid.has(jid) ? contactsMap.get(jidToLid.get(jid)) : null);
  if (guardado && guardado !== myName && !guardado.startsWith("Contacto WA") && !guardado.startsWith("+")) return guardado;

  // 2. Nombre de perfil asignado por el emisor (pushName)
  if (!fromMe && pushName && pushName !== myName) {
    contactsMap.set(jid, pushName);
    return pushName;
  }

  // 3. Fallback legible
  const base = jid.split("@")[0];
  if (jid.endsWith("@g.us")) return "Comunidad #" + base.slice(0, 6);
  if (jid.endsWith("@lid") || base.length > 12) return "Contacto WA  " + base.slice(-4);
  return "+" + base;
}

function guardarContacto(c) {
  if (!c) return;
  const nom = c.name || c.notify || c.verifiedName;
  if (c.id && c.lid) {
    lidToJid.set(c.lid, c.id);
    jidToLid.set(c.id, c.lid);
  }
  if (!nom || nom === myName) return;
  if (c.id) contactsMap.set(c.id, nom);
  if (c.lid) contactsMap.set(c.lid, nom);
}

function procesarMensaje(msg, esEnVivo = true) {
  if (!msg || !msg.message) return;
  const jid = msg.key?.remoteJid;
  if (!jid || jid.includes("@broadcast") || jid.includes("status@broadcast")) return;

  // Escudo Anti-Delete: detectar revocacion SOLO si el tipo es REVOKE (type 0)
  const raw = msg.message;
  const proto = raw.protocolMessage || raw.ephemeralMessage?.message?.protocolMessage;
  if (proto && (proto.type === 0 || proto.type === "REVOKE")) {
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
  const timeStr = formatearHoraMensaje(ts);
  const timeRel = formatearHora(ts);

  if (!messagesCache.has(jid)) messagesCache.set(jid, []);
  const lista = messagesCache.get(jid);
  const mStatus = msg.status || (fromMe ? 2 : 0);
  const isRead = Boolean(mStatus === 4 || mStatus === 5);
  lista.push({
    id: msg.key.id,
    fromMe,
    sender: msg.pushName || (fromMe ? "T" : "Contacto"),
    text,
    time: timeStr,
    timestamp: ts,
    status: mStatus,
    read: isRead
  });
  if (lista.length > 50) lista.shift();

  // Actualizar chatsCache
  const name = resolverNombre(jid, msg.pushName, fromMe);
  const prevUnread = chatsCache.has(jid) ? chatsCache.get(jid).unread : 0;
  const unread = fromMe ? 0 : (esEnVivo ? prevUnread + 1 : prevUnread);

  const prev = chatsCache.get(jid);
  if (!prev || ts >= (prev.timestamp || 0)) {
    chatsCache.set(jid, {
      id: jid,
      name,
      lastMsg: text,
      time: timeRel,
      unread,
      timestamp: ts,
      visto: fromMe ? false : true
    });
  } else if (prev && (!prev.name || prev.name.startsWith("Contacto WA") || prev.name.startsWith("+"))) {
    prev.name = name;
  }
}

async function startWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    let version = [2, 3000, 1015901307];
    try {
      const v = await fetchLatestBaileysVersion();
      if (v && v.version) version = v.version;
    } catch (ve) {
      console.log("[Baileys] Usando version default de WA:", version);
    }

    sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: state,
      browser: ["EspOS microPC", "Chrome", "20.0.04"],
      syncFullHistory: true,
      markOnlineOnConnect: true
    });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
      isConnected = false;
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[WhatsApp] Conexin cerrada (${statusCode}). Reconectando: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      } else {
        try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
        setTimeout(startWhatsApp, 2000);
      }
    } else if (connection === "open") {
      isConnected = true;
      currentQR = "";
      myNumber = sock.user.id.split(":")[0];
      myName = sock.user.name || "Gab";
      console.log(`[WhatsApp] Vinculado exitosamente: ${myName} (${myNumber})`);
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
        const rawTs = c.conversationTimestamp?.low || c.conversationTimestamp || c.lastMessageRecvTimestamp || c.lastMsgTimestamp || 0;
        const ts = Number(rawTs);
        if (!chatsCache.has(c.id)) {
          chatsCache.set(c.id, {
            id: c.id,
            name: nom,
            lastMsg: "Toca para abrir conversacin",
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

  // Manejo de actualizacion dinamica de chats en tiempo real
  const onChatsUpdate = (chatsList) => {
    if (!Array.isArray(chatsList)) return;
    for (const c of chatsList) {
      if (!c.id || c.id.includes("@broadcast") || c.id.includes("status@broadcast")) continue;
      const rawTs = c.conversationTimestamp?.low || c.conversationTimestamp || c.lastMessageRecvTimestamp || c.lastMsgTimestamp || 0;
      const ts = Number(rawTs);
      const nom = contactsMap.get(c.id) || (c.lid ? contactsMap.get(c.lid) : null) || c.name || resolverNombre(c.id, "", false);
      const prev = chatsCache.get(c.id);
      if (!prev) {
        chatsCache.set(c.id, {
          id: c.id,
          name: nom,
          lastMsg: "Toca para abrir conversacin",
          time: ts ? formatearHora(ts) : "",
          unread: c.unreadCount || 0,
          timestamp: ts
        });
      } else {
        if (nom && nom !== prev.name && !nom.startsWith("+") && !nom.startsWith("Contacto")) prev.name = nom;
        if (ts > (prev.timestamp || 0)) {
          prev.timestamp = ts;
          prev.time = formatearHora(ts);
        }
        if (typeof c.unreadCount === "number") prev.unread = c.unreadCount;
      }
    }
  };
  sock.ev.on("chats.upsert", onChatsUpdate);
  sock.ev.on("chats.update", onChatsUpdate);

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

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    for (const m of messages) procesarMensaje(m, true);
  });

  sock.ev.on("messages.update", (updates) => {
    for (const u of updates) {
      const jid = u.key?.remoteJid;
      const mid = u.key?.id;
      if (!jid || !mid) continue;
      const st = u.update?.status;
      if (messagesCache.has(jid)) {
        for (const item of messagesCache.get(jid)) {
          if (item.id === mid) {
            if (typeof st === "number") item.status = st;
            if (st === 4 || st === 5) item.read = true;
            break;
          }
        }
      }
      if (chatsCache.has(jid) && (st === 4 || st === 5)) {
        chatsCache.get(jid).visto = true;
      }
    }
  });

  sock.ev.on("call", (calls) => {
    for (const c of calls) {
      const ts = c.date ? Math.floor(new Date(c.date).getTime() / 1000) : Math.floor(Date.now() / 1000);
      const cid = c.chatId || c.from;
      const name = contactsMap.get(cid) || resolverNombre(cid, "", false);
      callsList.unshift({
        id: c.id,
        chatId: cid,
        name,
        time: formatearHora(ts),
        status: c.status,
        isVideo: Boolean(c.isVideo)
      });
      if (callsList.length > 20) callsList.pop();
    }
  });
  } catch (err) {
    console.error("[WhatsApp] Error critico en startWhatsApp:", err);
    setTimeout(startWhatsApp, 3000);
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Dashboard Web
  if (pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (isConnected) {
      return res.end(`<!DOCTYPE html><html><body style="background:#090d12;color:white;text-align:center;padding:40px;font-family:sans-serif;"><div style="max-width:420px;margin:auto;background:#131b24;border-radius:20px;padding:30px;border:1px solid #25d366;"><h2 style="color:#25d366;">&#10004; CONECTADO 24/7</h2><p>WhatsApp vinculado: <b>${myName}</b> (${myNumber})</p><p>Chats activos: <b>${chatsCache.size}</b></p></div></body></html>`);
    } else if (currentQR) {
      return res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="6"></head><body style="background:#090d12;color:white;text-align:center;padding:40px;font-family:sans-serif;"><div style="max-width:420px;margin:auto;background:#131b24;border-radius:20px;padding:30px;border:1px solid #38bdf8;"><h2>Vincular WhatsApp a EspOS</h2><img src="${currentQR}" style="width:260px;height:260px;background:white;padding:10px;border-radius:12px;"><p>Escanea desde WhatsApp &gt; Dispositivos vinculados</p></div></body></html>`);
    } else {
      return res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3"></head><body style="background:#090d12;color:white;text-align:center;padding:50px;font-family:sans-serif;"><h2>Iniciando EspCHAT Bridge...</h2></body></html>`);
    }
  }

  // API Status
  if (pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      conectado: isConnected,
      usuario: myName,
      numero: myNumber,
      totalChats: chatsCache.size
    }));
  }

  // API Chats (Unificado, desduplicado total y clasificado)
  if (pathname === "/api/chats" && req.method === "GET") {
    const vistanombres = new Set();
    const sorted = Array.from(chatsCache.values())
      .filter(c => c && c.id)
      .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

    // Primer paso: auto-asociar pares JID <-> LID que compartan nombre de agenda
    for (const c of sorted) {
      const isPersonal = !c.id.endsWith("@g.us") && !c.id.endsWith("@newsletter");
      const nom = (c.name || "").trim().toLowerCase();
      if (isPersonal && nom.length >= 3 && !nom.startsWith("contacto wa") && !nom.startsWith("+")) {
        for (const c2 of sorted) {
          if (c.id !== c2.id) {
            const nom2 = (c2.name || "").trim().toLowerCase();
            if (nom === nom2) {
              const jidEntry = c.id.endsWith("@s.whatsapp.net") ? c.id : (c2.id.endsWith("@s.whatsapp.net") ? c2.id : null);
              const lidEntry = c.id.endsWith("@lid") ? c.id : (c2.id.endsWith("@lid") ? c2.id : null);
              if (jidEntry && lidEntry) {
                lidToJid.set(lidEntry, jidEntry);
                jidToLid.set(jidEntry, lidEntry);
              }
            }
          }
        }
      }
    }

    const list = [];
    for (const c of sorted) {
      const peer = lidToJid.get(c.id) || jidToLid.get(c.id) || c.id;
      if (vistanombres.has(peer) || vistanombres.has(c.id)) continue;

      const isPersonal = !c.id.endsWith("@g.us") && !c.id.endsWith("@newsletter");
      const nom = (c.name || "").trim().toLowerCase();
      const esNombreValido = isPersonal && nom.length >= 3 &&
                             !nom.startsWith("contacto wa") &&
                             !nom.startsWith("+") &&
                             !nom.startsWith("comunidad");
      if (esNombreValido && vistanombres.has("NOM:" + nom)) continue;

      vistanombres.add(peer);
      vistanombres.add(c.id);
      if (esNombreValido) vistanombres.add("NOM:" + nom);
      
      // Indicar si es canal
      if (c.id.endsWith("@newsletter")) {
        c.esCanal = true;
      }
      list.push(c);
      if (list.length >= 50) break;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      conectado: isConnected,
      usuario: myName,
      numero: myNumber,
      totalChats: chatsCache.size,
      chats: list,
      llamadas: callsList
    }));
  }

  if (pathname === "/api/mensajes" && req.method === "GET") {
    const chatJid = parsedUrl.query.chat;
    let msgs = messagesCache.get(chatJid) || [];
    if (msgs.length === 0) {
      const alt = lidToJid.get(chatJid) || jidToLid.get(chatJid);
      if (alt && messagesCache.has(alt)) msgs = messagesCache.get(alt);
    }
    // Si no hay mensajes, intentar buscar por otro chat con el mismo nombre
    if (msgs.length === 0 && chatsCache.has(chatJid)) {
      const cNom = (chatsCache.get(chatJid).name || "").trim().toLowerCase();
      if (cNom.length >= 3 && !cNom.startsWith("contacto wa") && !cNom.startsWith("+")) {
        for (const [otherJid, otherChat] of chatsCache.entries()) {
          if (otherJid !== chatJid && (otherChat.name || "").trim().toLowerCase() === cNom) {
            if (messagesCache.has(otherJid) && messagesCache.get(otherJid).length > 0) {
              msgs = messagesCache.get(otherJid);
              lidToJid.set(chatJid, otherJid);
              jidToLid.set(otherJid, chatJid);
              break;
            }
          }
        }
      }
    }
    // Si aun esta vacio pero chatsCache conserva el ultimo mensaje real, sintetizarlo
    if (msgs.length === 0 && chatsCache.has(chatJid)) {
      const info = chatsCache.get(chatJid);
      if (info && info.lastMsg && !info.lastMsg.includes("Conversaci") && !info.lastMsg.includes("Toca para")) {
        msgs = [{
          id: "preview_" + (info.timestamp || Date.now()),
          fromMe: false,
          sender: info.name || "Contacto",
          text: info.lastMsg,
          time: info.time || "",
          timestamp: info.timestamp || 0
        }];
      }
    }
    if (chatsCache.has(chatJid)) chatsCache.get(chatJid).unread = 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ chat: chatJid, mensajes: msgs }));
  }

  // Endpoint de Avatares Nativo One UI: entrega 42x42 RGB565 (3528 bytes) exactos
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

      // 2. Pedir URL del avatar a WhatsApp con proteccion de timeout de 2.5s
      const withTimeout = (p, ms) => Promise.race([
        p,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms))
      ]);
      let ppUrl = await withTimeout(sock.profilePictureUrl(chatJid, "image"), 2500).catch(() => null);
      if (!ppUrl) {
        const alt = lidToJid.get(chatJid) || jidToLid.get(chatJid);
        if (alt) ppUrl = await withTimeout(sock.profilePictureUrl(alt, "image"), 2500).catch(() => null);
      }
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

        // Convertir RGB888 a RGB565 Little-Endian (formato directo para NavLz)
        const rgb565Buf = Buffer.alloc(42 * 42 * 2);
        for (let i = 0; i < 42 * 42; i++) {
          const r = data[i * 3];
          const g = data[i * 3 + 1];
          const b = data[i * 3 + 2];
          const c565 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
          rgb565Buf.writeUInt16LE(c565, i * 2);
        }

        fs.writeFileSync(rawPath, rgb565Buf);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": rgb565Buf.length,
          "Cache-Control": "public, max-age=604800"
        });
        return res.end(rgb565Buf);
      }

      // Fallback si no hay sharp
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      return res.end(imgBuffer);
    } catch (e) {
      console.log(`[Avatar] Error al procesar ${chatJid}:`, e.message);
      res.writeHead(404);
      return res.end();
    }
  }

  // API Enviar mensaje
  if (pathname === "/api/enviar" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { chat, texto } = JSON.parse(body);
        if (!chat || !texto || !sock) {
          res.writeHead(400); return res.end();
        }

        const sent = await sock.sendMessage(chat, { text: texto });
        const ts = Math.floor(Date.now() / 1000);
        const timeStr = formatearHoraMensaje(ts);
        const timeRel = formatearHora(ts);

        if (!messagesCache.has(chat)) messagesCache.set(chat, []);
        messagesCache.get(chat).push({
          id: sent.key.id,
          fromMe: true,
          sender: "T",
          text: texto,
          time: timeStr,
          timestamp: ts
        });

        if (chatsCache.has(chat)) {
          chatsCache.get(chat).lastMsg = texto;
          chatsCache.get(chat).time = timeRel;
          chatsCache.get(chat).timestamp = ts;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, id: sent.key.id }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[EspCHAT Bridge v2.3] Activo en puerto ${PORT}`);
  startWhatsApp();
});
