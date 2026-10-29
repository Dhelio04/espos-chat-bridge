/**
 * EspOS EspCHAT Cloud Bridge v2.8.2 - Real Sync, LastSeen Lima, Stickers & Audio WAV Engine - Sync chatsCache with messagesCache, Real lastMsg & Timestamps ("En línea", "Escribiendo...", "Grabando...", "últ. vez") & Zero Phone Leaks
 * - Sincronizacion en tiempo real con chats.upsert, chats.update y messaging-history.
 * - Desduplicacion inteligente de LIDs y telefonos (@lid <-> @s.whatsapp.net).
 * - Fechas relativas oficiales de WhatsApp (Hoy: 1:33 p.m., Ayer, Dia de semana, Fecha).
 * - Motor de Avatares Nativo One UI: 42x42 RGB565 Little-Endian (3528 bytes) procesado con Sharp.
 * - Escudo Anti-Delete persistente.
 */
const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, Browsers, jidNormalizedUser } = require("@whiskeysockets/baileys");
const { execFile } = require("child_process");
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
const stickersFolder = path.join(__dirname, "stickers_cache");
const photosFolder   = path.join(__dirname, "photos_cache");
if (!fs.existsSync(photosFolder)) fs.mkdirSync(photosFolder, { recursive: true });
const audioFolder = path.join(__dirname, "audio_cache");
if (!fs.existsSync(avatarsFolder)) fs.mkdirSync(avatarsFolder, { recursive: true });
if (!fs.existsSync(stickersFolder)) fs.mkdirSync(stickersFolder, { recursive: true });
if (!fs.existsSync(audioFolder)) fs.mkdirSync(audioFolder, { recursive: true });

// Purgar cache de stickers antiguos generados con stride incorrecto (v2.8.2)
try {
  if (fs.existsSync(stickersFolder)) {
    const sFiles = fs.readdirSync(stickersFolder);
    for (const f of sFiles) {
      try { fs.unlinkSync(path.join(stickersFolder, f)); } catch (_) {}
    }
    console.log(`[Stickers] Cache purgado al iniciar (${sFiles.length} stickers limpiados)`);
  }
} catch (e) {
  console.warn('[Stickers] Error purgando cache:', e.message);
}

const rawMediaMap = new Map(); // msgId -> WAMessage

const allMessagesMap = new Map(); // msgId -> raw WAMessage
const groupMetaCache = new Map(); // jid -> { announce: boolean, soloAdmins: boolean, ts: number }

async function obtenerPermisosGrupo(jid) {
  if (!jid || !jid.endsWith("@g.us")) return false;
  const ahora = Date.now();
  if (groupMetaCache.has(jid)) {
    const item = groupMetaCache.get(jid);
    if (ahora - item.ts < 300000) return item.soloAdmins;
  }
  if (!sock) return false;
  try {
    const meta = await sock.groupMetadata(jid);
    const soloAdminsConfig = Boolean(meta.announce);
    if (!soloAdminsConfig) {
      groupMetaCache.set(jid, { announce: false, soloAdmins: false, ts: ahora });
      return false;
    }
    const myJidNorm = myNumber ? `${myNumber}@s.whatsapp.net` : (sock.user?.id ? jidNormalizedUser(sock.user.id) : "");
    const myLidNorm = myLid ? jidNormalizedUser(myLid) : "";
    const soyAdmin = (meta.participants || []).some(p => {
      if (!p || !p.id) return false;
      const pJid = jidNormalizedUser(p.id);
      const pNum = p.id.split("@")[0].split(":")[0];
      const coincide = (myJidNorm && pJid === myJidNorm) ||
                       (myLidNorm && pJid === myLidNorm) ||
                       (myNumber && (pNum === myNumber || pJid.includes(myNumber))) ||
                       (myLid && p.id.startsWith(myLid.split("@")[0]));
      return coincide && (p.admin === "admin" || p.admin === "superadmin");
    });
    const restringido = soloAdminsConfig && !soyAdmin;
    groupMetaCache.set(jid, { announce: true, soloAdmins: restringido, ts: ahora });
    return restringido;
  } catch (e) {
    return false;
  }
}


let sock = null;
let isConnected = false;
let myNumber = "";
let myName = "";
let myLid = "75798220378356@lid";
let currentQR = "";
let rawQR = "";
let chatsCache = new Map();
let messagesCache = new Map();
let agendaMap = new Map();   // JID / LID -> Nombre guardado por el usuario en su agenda (Google Contacts)
let pushNameMap = new Map(); // JID / LID -> Apodo que el contacto se puso a si mismo
let contactsMap = agendaMap; // Alias de compatibilidad
let lidToJid = new Map();    // LID -> JID
let jidToLid = new Map();    // JID -> LID
let presenceMap = new Map();  // JID -> { status: "available"|"composing"|..., t: number }
let callsList = [];

// Persistencia en disco para que reinicios o redeploys nunca borren nombres ni historiales
const storeFile = path.join(__dirname, "espos_store.json");

function cargarStoreDisco() {
  try {
    if (fs.existsSync(storeFile)) {
      const data = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
      if (data.agenda) {
        for (const [k, v] of Object.entries(data.agenda)) agendaMap.set(k, v);
      }
      if (data.pushNames) {
        for (const [k, v] of Object.entries(data.pushNames)) pushNameMap.set(k, v);
      }
      if (data.contacts && agendaMap.size === 0) {
        for (const [k, v] of Object.entries(data.contacts)) agendaMap.set(k, v);
      }
      if (data.lidToJid) {
        for (const [k, v] of Object.entries(data.lidToJid)) lidToJid.set(k, v);
      }
      if (data.jidToLid) {
        for (const [k, v] of Object.entries(data.jidToLid)) jidToLid.set(k, v);
      }
      if (data.chats) {
        for (const [k, v] of Object.entries(data.chats)) chatsCache.set(k, v);
      }
      if (data.messages) {
        const ahoraSeg = Math.floor(Date.now() / 1000);
        for (const [k, v] of Object.entries(data.messages)) {
          if (Array.isArray(v)) {
            // Solo restaurar mensajes recientes de las ultimas 24 horas para evitar revivir historiales obsoletos
            const recientes = v.filter(m => (ahoraSeg - (Number(m.timestamp) || 0)) < 86400).slice(-30);
            if (recientes.length > 0) messagesCache.set(k, recientes);
          }
        }
      }
      if (data.rawMedia) {
        for (const [k, v] of Object.entries(data.rawMedia)) {
          rawMediaMap.set(k, v);
        }
      }
      console.log(`[Store] Restaurado desde disco: ${chatsCache.size} chats, ${messagesCache.size} historiales, ${contactsMap.size} contactos.`);
    }
  } catch (e) {
    console.error("[Store] Error cargando store de disco:", e.message);
  }
}
cargarStoreDisco();

let guardarTimer = null;

function formatearUltimaVez(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    const ahora = new Date();
    const opcionesHora = { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Lima" };
    const strHora = d.toLocaleTimeString("es-PE", opcionesHora);
    const strFechaMsg = d.toLocaleDateString("en-CA", { timeZone: "America/Lima" });
    const strFechaHoy = ahora.toLocaleDateString("en-CA", { timeZone: "America/Lima" });
    if (strFechaMsg === strFechaHoy) {
      return `ult. vez hoy a las ${strHora}`;
    }
    const ayer = new Date(ahora.getTime() - 86400000);
    const strFechaAyer = ayer.toLocaleDateString("en-CA", { timeZone: "America/Lima" });
    if (strFechaMsg === strFechaAyer) {
      return `ult. vez ayer a las ${strHora}`;
    }
    const strFechaCorta = d.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", timeZone: "America/Lima" });
    return `ult. vez el ${strFechaCorta} a las ${strHora}`;
  } catch (e) {
    return "";
  }
}

function programarGuardadoDisco() {
  if (guardarTimer) clearTimeout(guardarTimer);
  guardarTimer = setTimeout(() => {
    try {
      const ahoraSeg = Math.floor(Date.now() / 1000);
      const msgsFrescos = {};
      for (const [k, v] of messagesCache.entries()) {
        if (Array.isArray(v)) {
          const filtrados = v.filter(m => (ahoraSeg - (Number(m.timestamp) || 0)) < 86400).slice(-30);
          if (filtrados.length > 0) msgsFrescos[k] = filtrados;
        }
      }
      const payload = {
        agenda: Object.fromEntries(agendaMap.entries()),
        pushNames: Object.fromEntries(pushNameMap.entries()),
        contacts: Object.fromEntries(agendaMap.entries()),
        lidToJid: Object.fromEntries(lidToJid.entries()),
        jidToLid: Object.fromEntries(jidToLid.entries()),
        chats: Object.fromEntries(chatsCache.entries()),
        messages: msgsFrescos,
        rawMedia: Object.fromEntries(Array.from(rawMediaMap.entries()).slice(-100))
      };
      fs.writeFileSync(storeFile, JSON.stringify(payload));
    } catch (e) {
      console.error("[Store] Error guardando store en disco:", e.message);
    }
  }, 2000);
}

async function sincronizarGruposReales() {
  if (!sock) return;
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const [gid, gdata] of Object.entries(groups)) {
      if (gdata.subject) {
        contactsMap.set(gid, gdata.subject);
        if (chatsCache.has(gid)) {
          chatsCache.get(gid).name = gdata.subject;
        } else {
          let gTs = gdata.creation ? Number(gdata.creation) : 0;
          let gLast = "";
          let gTime = "";
          if (messagesCache.has(gid)) {
            const ms = messagesCache.get(gid);
            if (ms.length > 0) {
              const u = ms[ms.length - 1];
              if (u.timestamp) gTs = u.timestamp;
              if (u.text) gLast = u.text;
              if (u.time) gTime = u.time;
            }
          }
          chatsCache.set(gid, {
            id: gid,
            name: gdata.subject,
            lastMsg: gLast,
            time: gTime,
            unread: 0,
            timestamp: gTs
          });
        }
      }
    }
    console.log(`[WhatsApp] ${Object.keys(groups).length} grupos sincronizados con sus nombres reales.`);
    programarGuardadoDisco();
  } catch (ge) {
    console.error("[WhatsApp] Error obteniendo grupos:", ge.message);
  }
}

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
  const esPropio = (myNumber && jid.includes(myNumber)) ||
                   (myLid && (jid === myLid || jid.startsWith(myLid.split("@")[0]))) ||
                   (jid === "75798220378356@lid");
  if (esPropio && !jid.endsWith("@g.us")) return "Mensajes Guardados (Tú)";
  
  const alt = lidToJid.get(jid) || jidToLid.get(jid);

  // 1. PRIORIDAD MAXIMA: Agenda del usuario (lo que Gabriel guardo en su telefono)
  const nomAgenda = agendaMap.get(jid) || (alt ? agendaMap.get(alt) : null);
  if (nomAgenda && nomAgenda !== myName && !nomAgenda.startsWith("Contacto WA") && !nomAgenda.startsWith("Comunidad #") && !nomAgenda.startsWith("+")) {
    return nomAgenda;
  }

  // 2. Si chatsCache ya tiene un nombre guardado de agenda, conservarlo intacto
  if (chatsCache.has(jid)) {
    const cName = chatsCache.get(jid).name;
    if (cName && !cName.startsWith("Contacto WA") && !cName.startsWith("Comunidad #") && !cName.startsWith("+")) {
      return cName;
    }
  }
  if (alt && chatsCache.has(alt)) {
    const cName = chatsCache.get(alt).name;
    if (cName && !cName.startsWith("Contacto WA") && !cName.startsWith("Comunidad #") && !cName.startsWith("+")) {
      return cName;
    }
  }

  // 3. PRIORIDAD SECUNDARIA: Apodo asignado por el emisor (pushName)
  const nomPush = (!fromMe && pushName && pushName !== myName) ? pushName : (pushNameMap.get(jid) || (alt ? pushNameMap.get(alt) : null));
  if (nomPush && nomPush !== myName) {
    pushNameMap.set(jid, nomPush);
    if (alt) pushNameMap.set(alt, nomPush);
    return nomPush;
  }

  // 4. Buscar si en el historial de mensajes el emisor dejo su pushName
  const histMsgs = messagesCache.get(jid) || (alt ? messagesCache.get(alt) : null);
  if (Array.isArray(histMsgs)) {
    for (const m of histMsgs) {
      if (!m.fromMe && m.sender && m.sender !== "Contacto" && m.sender !== myName && !m.sender.startsWith("Contacto WA") && !m.sender.startsWith("+")) {
        pushNameMap.set(jid, m.sender);
        if (alt) pushNameMap.set(alt, m.sender);
        return m.sender;
      }
    }
  }

  // 5. Fallback legible
  const base = jid.split("@")[0];
  if (jid.endsWith("@g.us")) return "Comunidad #" + base.slice(0, 6);
  if (jid.endsWith("@lid") || base.length > 12) return "Contacto WA  " + base.slice(-4);
  return "+" + base;
}

function guardarContacto(c) {
  if (!c) return;
  if (c.id && c.lid) {
    lidToJid.set(c.lid, c.id);
    jidToLid.set(c.id, c.lid);
  }
  // c.name es el nombre real guardado en la agenda de Google Contacts / telefono del usuario
  if (c.name && c.name !== myName && !c.name.startsWith("+") && !c.name.startsWith("Contacto WA")) {
    if (c.id) agendaMap.set(c.id, c.name);
    if (c.lid) agendaMap.set(c.lid, c.name);
    if (chatsCache.has(c.id)) chatsCache.get(c.id).name = c.name;
    if (c.lid && chatsCache.has(c.lid)) chatsCache.get(c.lid).name = c.name;
    programarGuardadoDisco();
  }
  // c.notify / pushName es el apodo secundario que el emisor se puso a si mismo
  const apodo = c.notify || c.verifiedName;
  if (apodo && apodo !== myName) {
    if (c.id) pushNameMap.set(c.id, apodo);
    if (c.lid) pushNameMap.set(c.lid, apodo);
    // Solo asignar a chatsCache si NO hay un nombre en agendaMap
    if (c.id && (!agendaMap.has(c.id) || !agendaMap.get(c.id))) {
      if (chatsCache.has(c.id)) {
        const cur = chatsCache.get(c.id).name;
        if (!cur || cur.startsWith("+") || cur.startsWith("Contacto WA")) chatsCache.get(c.id).name = apodo;
      }
    }
    programarGuardadoDisco();
  }
}

function procesarMensaje(msg, esEnVivo = true) {
  if (!msg || !msg.message) return;
  let jid = msg.key?.remoteJid;
  if (!jid || jid.includes("@broadcast") || jid.includes("status@broadcast")) return;

  // Unificar chat propio: si el mensaje proviene o va a mi LID o a mi numero, normalizarlo siempre a myJid
  const myJid = myNumber ? `${myNumber}@s.whatsapp.net` : "51933961359@s.whatsapp.net";
  const esPropio = (jid === myLid) || (jid === "75798220378356@lid") ||
                   (myNumber && jid.includes(myNumber) && !jid.endsWith("@g.us"));
  if (esPropio) {
    jid = myJid;
  }

  // Registrar en rawMediaMap si tiene sticker o audio para descarga bajo demanda
  let innerMsg = msg.message;
  if (innerMsg?.ephemeralMessage?.message) innerMsg = innerMsg.ephemeralMessage.message;
  if (innerMsg?.viewOnceMessage?.message) innerMsg = innerMsg.viewOnceMessage.message;
  if (innerMsg?.viewOnceMessageV2?.message) innerMsg = innerMsg.viewOnceMessageV2.message;
  if (innerMsg?.documentWithCaptionMessage?.message) innerMsg = innerMsg.documentWithCaptionMessage.message;

  if (msg.key?.id && (innerMsg?.stickerMessage || innerMsg?.audioMessage || innerMsg?.imageMessage || innerMsg?.videoMessage)) {
    rawMediaMap.set(msg.key.id, msg);
    if (rawMediaMap.size > 500) {
      const k = rawMediaMap.keys().next().value;
      rawMediaMap.delete(k);
    }
    // Precarga asincrona inmediata de stickers a formato RGB565 One UI (Deduplicacion SHA256)
    if (innerMsg?.stickerMessage && sharp && esEnVivo) {
      let sId = msg.key.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      if (innerMsg.stickerMessage.fileSha256) {
        sId = Buffer.from(innerMsg.stickerMessage.fileSha256).toString("hex").substring(0, 32);
      }
      if (sId !== msg.key.id) rawMediaMap.set(sId, msg);
      const rPath = path.join(stickersFolder, `${sId}.raw`);
      if (!fs.existsSync(rPath)) {
        downloadMediaMessage(msg, "buffer", {}, {
          logger: pino({ level: "silent" }),
          reuploadRequest: sock?.updateMediaMessage
        }).then(buf => {
          if (buf) {
            try { fs.writeFileSync(path.join(stickersFolder, `${sId}.webp`), buf); } catch (_) {}
            return sharp(buf, { page: 0 })
              .resize(64, 64, { fit: "contain", background: { r: 19, g: 27, b: 36, alpha: 1 } })
              .flatten({ background: { r: 19, g: 27, b: 36 } })
              .raw()
              .toBuffer({ resolveWithObject: true });
          }
        }).then(resObj => {
          if (resObj && resObj.data) {
            const data = resObj.data;
            const channels = resObj.info.channels || 3;
            const rgb565 = Buffer.alloc(64 * 64 * 2);
            for (let i = 0; i < 64 * 64; i++) {
              const r = data[i * channels];
              const g = data[i * channels + 1];
              const b = data[i * channels + 2];
              const c16 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
              rgb565.writeUInt16LE(c16, i * 2);
            }
            fs.writeFileSync(rPath, rgb565);
          }
        }).catch(() => {});
      }
    }
  }

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
  // Presencia: solo eventos reales de WhatsApp presencia
  const ts = rawTs ? (typeof rawTs === "number" ? rawTs : Number(rawTs.low || rawTs)) : Math.floor(Date.now() / 1000);
  const timeStr = formatearHoraMensaje(ts);
  const timeRel = formatearHora(ts);

  if (!messagesCache.has(jid)) messagesCache.set(jid, []);
  const lista = messagesCache.get(jid);
  const mStatus = msg.status || (fromMe ? 2 : 0);
  const isRead = Boolean(mStatus === 4 || mStatus === 5);
  let durSec = 0;
  let tipoMsg = "texto";
  let msgItemId = msg.key.id;
  if (innerMsg?.audioMessage?.seconds) {
    durSec = Math.round(Number(innerMsg.audioMessage.seconds));
    tipoMsg = "audio";
  } else if (innerMsg?.stickerMessage) {
    tipoMsg = "sticker";
    if (innerMsg.stickerMessage.fileSha256) {
      msgItemId = Buffer.from(innerMsg.stickerMessage.fileSha256).toString("hex").substring(0, 32);
    }
  } else if (innerMsg?.imageMessage) {
    tipoMsg = "foto";
  } else if (innerMsg?.videoMessage) {
    tipoMsg = "video";
    durSec = Math.round(Number(innerMsg.videoMessage.seconds) || 0);
  }
  lista.push({
    id: msgItemId,
    fromMe,
    sender: msg.pushName || (fromMe ? "T\u00fa" : "Contacto"),
    text,
    tipo: tipoMsg,
    time: timeStr,
    timestamp: ts,
    duration: durSec,
    status: mStatus,
    read: isRead
  });
  if (lista.length > 30) lista.shift();

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
      fromMe: fromMe,
      visto: fromMe ? false : true
    });
  } else if (prev && (!prev.name || prev.name.startsWith("Contacto WA") || prev.name.startsWith("+"))) {
    prev.name = name;
  }
  programarGuardadoDisco();
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
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" }))
      },
      browser: ["EspOS microPC", "Chrome", "20.0.04"],
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: true,
      getMessage: async (key) => {
        if (!key?.id) return undefined;
        // 1. Buscar en el mapa rapido de mensajes completos (por ID)
        if (allMessagesMap.has(key.id)) {
          return allMessagesMap.get(key.id);
        }
        // 2. Buscar en la cache de mensajes por remoteJid si existe
        if (key.remoteJid && messagesCache.has(key.remoteJid)) {
          const m = messagesCache.get(key.remoteJid).find(x => x.id === key.id);
          if (m) return { conversation: m.text };
        }
        // 3. Buscar en todas las listas de messagesCache
        for (const list of messagesCache.values()) {
          const m = list.find(x => x.id === key.id);
          if (m) return { conversation: m.text };
        }
        return undefined;
      }
    });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      rawQR = qr;
      currentQR = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
      isConnected = false;
    }

        if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401;
      console.log(`[WhatsApp] Conexión cerrada (${statusCode}). Reconectando: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      } else {
        console.log("[WhatsApp] Sesión cerrada formalmente (loggedOut). Purgando credenciales...");
        try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
        rawQR = "";
        currentQR = "";
        setTimeout(startWhatsApp, 2000);
      }
    } else if (connection === "open") {
      isConnected = true;
      currentQR = "";
      myNumber = sock.user.id.split(":")[0];
      myName = sock.user.name || "Gab";
      if (sock.user.lid) {
        myLid = sock.user.lid.split(":")[0] + "@lid";
      }
      if (!myLid && myNumber === "51933961359") {
        myLid = "75798220378356@lid";
      }
      const myJid = `${myNumber}@s.whatsapp.net`;
      if (myLid) {
        lidToJid.set(myLid, myJid);
        jidToLid.set(myJid, myLid);
      }
      console.log(`[WhatsApp] Vinculado exitosamente: ${myName} (${myNumber}) LID: ${myLid}`);
      sincronizarGruposReales();
    }
  });

  sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
    if (Array.isArray(contacts)) {
      for (const c of contacts) guardarContacto(c);
    }
    if (Array.isArray(messages)) {
      for (const m of messages) {
        if (m.key?.id && m.message) {
          allMessagesMap.set(m.key.id, m.message);
        }
        procesarMensaje(m, false);
      }
    }
    if (Array.isArray(chats)) {
      for (const c of chats) {
        if (!c.id || c.id.includes("@broadcast") || c.id.includes("status@broadcast")) continue;
        const alt = lidToJid.get(c.id) || jidToLid.get(c.id);
        const nom = contactsMap.get(c.id) || (alt ? contactsMap.get(alt) : null) || c.name || resolverNombre(c.id, "", false);
        const rawTs = c.conversationTimestamp?.low || c.conversationTimestamp || c.lastMessageRecvTimestamp || c.lastMsgTimestamp || 0;
        const ts = Number(rawTs);
        if (!chatsCache.has(c.id)) {
          chatsCache.set(c.id, {
            id: c.id,
            name: nom,
            lastMsg: "",
            time: ts ? formatearHora(ts) : "",
            unread: c.unreadCount || 0,
            timestamp: ts
          });
        } else {
          const cur = chatsCache.get(c.id);
          if (nom && !nom.startsWith("Contacto WA") && (!cur.name || cur.name.startsWith("Contacto WA"))) {
            cur.name = nom;
          }
        }
      }
    }
    programarGuardadoDisco();
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
          lastMsg: "",
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
      const nom = resolverNombre(c.id, c.notify || c.verifiedName, false);
      if (c && nom && nom !== myName) {
        if (chatsCache.has(c.id)) chatsCache.get(c.id).name = nom;
        if (c.lid && chatsCache.has(c.lid)) chatsCache.get(c.lid).name = nom;
      }
    }
  };
  sock.ev.on("contacts.upsert", onContacts);
  sock.ev.on("contacts.update", onContacts);

    sock.ev.on("groups.update", async (updates) => {
    for (const u of updates) { if (u?.id) groupMetaCache.delete(u.id); }
  });
  sock.ev.on("group-participants.update", async (update) => {
    if (update?.id) groupMetaCache.delete(update.id);
  });
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    for (const m of messages) {
      if (m.key?.id && m.message) {
        allMessagesMap.set(m.key.id, m.message);
        if (allMessagesMap.size > 800) {
          const firstKey = allMessagesMap.keys().next().value;
          allMessagesMap.delete(firstKey);
        }
      }
      procesarMensaje(m, true);
    }
  });

  sock.ev.on("presence.update", ({ id, presences }) => {
    if (!presences) return;
    for (const [sender, p] of Object.entries(presences)) {
      const j = id || sender;
      const st = p.lastKnownPresence;
      const cur = presenceMap.get(j) || {};
      cur.status = st;
      if (st === "available" || st === "composing" || st === "recording") {
        cur.t = Date.now();
      } else if (st === "unavailable") {
        cur.t = 0;
        if (p.lastSeen) {
          const ls = Number(p.lastSeen);
          cur.lastSeen = ls < 2000000000 ? ls * 1000 : ls;
        } else {
          cur.lastSeen = null;
        }
      }
      presenceMap.set(j, cur);
      const alt = lidToJid.get(j) || jidToLid.get(j);
      if (alt) presenceMap.set(alt, cur);
    }
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
  if (pathname === "/api/contacto/renombrar" && (req.method === "POST" || req.method === "GET")) {
    const cJid = parsedUrl.query.chat;
    const cNom = parsedUrl.query.nombre;
    if (cJid && cNom) {
      agendaMap.set(cJid, cNom.trim());
      const altJid = lidToJid.get(cJid) || jidToLid.get(cJid);
      if (altJid) agendaMap.set(altJid, cNom.trim());
      if (chatsCache.has(cJid)) chatsCache.get(cJid).name = cNom.trim();
      if (altJid && chatsCache.has(altJid)) chatsCache.get(altJid).name = cNom.trim();
      programarGuardadoDisco();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, jid: cJid, nombre: cNom.trim() }));
    }
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Faltan parametros chat y nombre" }));
  }

  if (pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      conectado: isConnected,
      usuario: myName,
      numero: myNumber,
      totalChats: chatsCache.size,
      qr: isConnected ? "" : (rawQR || "")
    }));
  }

  // API Chats (Unificado, desduplicado total y clasificado)
  
  // Endpoint para vaciar cache de mensajes obsoletos y stickers (Regla de frescura)
  if ((pathname === "/api/limpiar" || pathname === "/api/vaciar_cache") && req.method === "GET") {
    messagesCache.clear();
    try {
      if (fs.existsSync(stickersFolder)) {
        const files = fs.readdirSync(stickersFolder);
        for (const f of files) {
          try { fs.unlinkSync(path.join(stickersFolder, f)); } catch (_) {}
        }
      }
    } catch (_) {}
    programarGuardadoDisco();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, mensaje: "Cache de mensajes y stickers vaciado con exito (solo 30 ultimos activos)" }));
  }

  // Endpoint para resetear credenciales corruptas y forzar nuevo QR limpio al instante
  if ((pathname === "/api/reset_auth" || pathname === "/api/reset") && req.method === "GET") {
    try {
      if (sock) {
        try { sock.end(); } catch (_) {}
        sock = null;
      }
      isConnected = false;
      rawQR = "";
      currentQR = "";
      if (fs.existsSync(authFolder)) {
        fs.rmSync(authFolder, { recursive: true, force: true });
      }
      setTimeout(startWhatsApp, 1000);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, mensaje: "Sesion reiniciada limpiamente. Generando nuevo QR..." }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // Endpoint de diagnostico avanzado
  if (pathname === "/api/diag" && req.method === "GET") {
    let authFiles = [];
    try {
      if (fs.existsSync(authFolder)) {
        authFiles = fs.readdirSync(authFolder);
      }
    } catch (e) {}
    const sessionFiles = authFiles.filter(f => f.startsWith("session-"));
    const prekeyFiles = authFiles.filter(f => f.startsWith("pre-key-"));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      version: "2.9.5",
      uptime: Math.round(process.uptime()),
      connected: isConnected,
      myNumber,
      myLid,
      sockUserId: sock?.user?.id || null,
      authFolderExists: fs.existsSync(authFolder),
      credsExists: fs.existsSync(path.join(authFolder, "creds.json")),
      sessionFilesCount: sessionFiles.length,
      prekeyFilesCount: prekeyFiles.length,
      sampleSessions: sessionFiles.filter(f => f.includes("51933961359") || f.includes("75798220378356")),
      allMessagesMapSize: allMessagesMap.size,
      groupsCached: groupMetaCache.size
    }));
  }

  // Endpoint para purgar sesiones Signal desincronizadas (stale) conservando creds.json (sin nuevo QR)
  if (pathname === "/api/limpiar_sesiones_e2ee" && req.method === "GET") {
    let eliminados = 0;
    try {
      if (fs.existsSync(authFolder)) {
        const files = fs.readdirSync(authFolder);
        for (const file of files) {
          if (file.startsWith("session-") || file.startsWith("pre-key-")) {
            fs.unlinkSync(path.join(authFolder, file));
            eliminados++;
          }
        }
      }
      if (sock) {
        try { sock.end(); } catch (_) {}
      }
      setTimeout(startWhatsApp, 1500);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        ok: true,
        archivosEliminados: eliminados,
        mensaje: "Sesiones E2EE limpiadas con exito. creds.json conservado. Reiniciando handshake..."
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (pathname === "/api/chats" && req.method === "GET") {
    // Sincronizar chatsCache con el mensaje mas reciente de messagesCache solo si es mas nuevo
    for (const [jid, mList] of messagesCache.entries()) {
      if (Array.isArray(mList) && mList.length > 0) {
        const ult = mList[mList.length - 1];
        if (ult) {
          const c = chatsCache.get(jid) || { id: jid, name: contactsMap.get(jid) || resolverNombre(jid, "", false), unread: 0 };
          const ultTs = Number(ult.timestamp) || 0;
          const curTs = Number(c.timestamp) || 0;
          if (ultTs >= curTs || !c.lastMsg) {
            if (ult.text && !ult.text.includes("Conversaci") && !ult.text.includes("Toca para")) {
              c.lastMsg = ult.text;
            }
            if (ult.time) c.time = ult.time;
            if (ultTs > 0) c.timestamp = ultTs;
            c.fromMe = Boolean(ult.fromMe);
          }
          chatsCache.set(jid, c);
        }
      }
    }

    const myJid = myNumber ? `${myNumber}@s.whatsapp.net` : "51933961359@s.whatsapp.net";
    const myLidStr = myLid || "75798220378356@lid";

    // Unificar cualquier rastro de mi propio LID dentro de myJid ("Mensajes Guardados (Tú)")
    for (const lidKey of [myLidStr, "75798220378356@lid"]) {
      if (chatsCache.has(lidKey)) {
        const cLid = chatsCache.get(lidKey);
        const cJid = chatsCache.get(myJid);
        if (cJid && cLid) {
          if ((Number(cLid.timestamp) || 0) >= (Number(cJid.timestamp) || 0)) {
            cJid.lastMsg = cLid.lastMsg;
            cJid.time = cLid.time;
            cJid.timestamp = cLid.timestamp;
            cJid.fromMe = cLid.fromMe;
          }
        } else if (!cJid && cLid) {
          cLid.id = myJid;
          cLid.name = "Mensajes Guardados (Tú)";
          chatsCache.set(myJid, cLid);
        }
        chatsCache.delete(lidKey);
      }
      if (messagesCache.has(lidKey)) {
        const msgsLid = messagesCache.get(lidKey) || [];
        const msgsJid = messagesCache.get(myJid) || [];
        const ids = new Set(msgsJid.map(m => m.id));
        for (const m of msgsLid) {
          if (!ids.has(m.id)) {
            msgsJid.push(m);
            ids.add(m.id);
          }
        }
        msgsJid.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
        while (msgsJid.length > 30) msgsJid.shift();
        messagesCache.set(myJid, msgsJid);
        messagesCache.delete(lidKey);
      }
    }
    if (chatsCache.has(myJid)) {
      chatsCache.get(myJid).name = "Mensajes Guardados (Tú)";
    }

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
      // Excluir stubs vacios de LID que no tienen nombre real ni mensajes
      const esLidSinMensajes = c.id.endsWith("@lid") && (!c.lastMsg || c.lastMsg === "") && (!c.name || c.name.startsWith("Contacto WA"));
      if (esLidSinMensajes) continue;
      const alt = lidToJid.get(c.id) || jidToLid.get(c.id);
      const realNom = contactsMap.get(c.id) || (alt ? contactsMap.get(alt) : null);
      if (realNom && !realNom.startsWith("Contacto WA") && !realNom.startsWith("Comunidad #")) {
        c.name = realNom;
      }
      if (c.lastMsg && (c.lastMsg.includes("Toca para abrir") || c.lastMsg.includes("Conversaci"))) {
        c.lastMsg = "";
      }

      // Si lastMsg sigue vacio, buscar el ultimo mensaje en messagesCache
      if (!c.lastMsg || c.lastMsg === "") {
        const mList = messagesCache.get(c.id) || (alt ? messagesCache.get(alt) : null);
        if (mList && mList.length > 0) {
          const ult = mList[mList.length - 1];
          if (ult && ult.text && !ult.text.includes("Conversaci") && !ult.text.includes("Toca para")) {
            c.lastMsg = ult.text;
            c.time = ult.time || c.time;
            c.timestamp = ult.timestamp || c.timestamp;
            c.fromMe = Boolean(ult.fromMe);
          }
        }
      }

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
        c.soloAdmins = true;
      }
      // Indicar si es grupo y si solo administradores pueden hablar
      if (c.id.endsWith("@g.us")) {
        c.esGrupo = true;
        if (groupMetaCache.has(c.id)) {
          c.soloAdmins = groupMetaCache.get(c.id).soloAdmins;
        } else {
          c.soloAdmins = false;
          obtenerPermisosGrupo(c.id).catch(() => {});
        }
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
      qr: isConnected ? "" : (rawQR || ""),
      chats: list,
      llamadas: callsList
    }));
  }

  if (pathname === "/api/mensajes" && req.method === "GET") {
    let chatJid = parsedUrl.query.chat;
    const myJid = myNumber ? `${myNumber}@s.whatsapp.net` : "51933961359@s.whatsapp.net";
    const myLidStr = myLid || "75798220378356@lid";
    if (chatJid === myLidStr || chatJid === "75798220378356@lid" || (myNumber && chatJid && chatJid.includes(myNumber) && !chatJid.endsWith("@g.us"))) {
      chatJid = myJid;
    }
    if (sock && chatJid) {
      sock.presenceSubscribe(chatJid).catch(() => {});
      const altJid = lidToJid.get(chatJid) || jidToLid.get(chatJid);
      if (altJid) sock.presenceSubscribe(altJid).catch(() => {});
    }

    let msgs = [...(messagesCache.get(chatJid) || [])];
    const alt = lidToJid.get(chatJid) || jidToLid.get(chatJid);
    if (msgs.length === 0 && alt && messagesCache.has(alt)) {
      msgs = [...messagesCache.get(alt)];
    }
    // Si no hay mensajes, intentar buscar por otro chat con el mismo nombre
    if (msgs.length === 0 && chatsCache.has(chatJid)) {
      const cNom = (chatsCache.get(chatJid).name || "").trim().toLowerCase();
      if (cNom.length >= 3 && !cNom.startsWith("contacto wa") && !cNom.startsWith("+")) {
        for (const [otherJid, otherChat] of chatsCache.entries()) {
          if (otherJid !== chatJid && (otherChat.name || "").trim().toLowerCase() === cNom) {
            if (messagesCache.has(otherJid) && messagesCache.get(otherJid).length > 0) {
              msgs = [...messagesCache.get(otherJid)];
              lidToJid.set(chatJid, otherJid);
              jidToLid.set(otherJid, chatJid);
              break;
            }
          }
        }
      }
    }
    // Incorporar el mensaje mas reciente de chatsCache si messagesCache esta vacio o desfasado
    const info = chatsCache.get(chatJid) || (alt ? chatsCache.get(alt) : null);
    if (info && info.lastMsg && !info.lastMsg.includes("Conversaci") && !info.lastMsg.includes("Toca para")) {
      const lastMsgTs = (msgs.length > 0 && msgs[msgs.length - 1].timestamp) ? Number(msgs[msgs.length - 1].timestamp) : 0;
      const infoTs = Number(info.timestamp || 0);

      // Incorporar el mensaje mas reciente si la lista esta vacia o infoTs es mas nuevo
      if (msgs.length === 0 || (infoTs > 0 && infoTs > lastMsgTs)) {
        const fm = Boolean(info.fromMe);
        msgs.push({
          id: "latest_" + (infoTs || Date.now()),
          fromMe: fm,
          sender: fm ? (myName || "Tú") : (info.name || "Contacto"),
          text: info.lastMsg,
          time: info.time || "",
          timestamp: infoTs || Math.floor(Date.now() / 1000),
          read: true
        });
      }
    }
    if (chatsCache.has(chatJid)) chatsCache.get(chatJid).unread = 0;

    // Deduplicar mensajes por id y ordenar estrictamente de mas antiguo a mas reciente
    const mapMsg = new Map();
    for (const m of msgs) {
      if (m && m.id) mapMsg.set(m.id, m);
    }
    msgs = Array.from(mapMsg.values()).sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
    if (msgs.length > 30) {
      msgs = msgs.slice(-30);
    }

    // Resolver presencia en tiempo real con precision oficial (cero falsos 'en linea' ni horas inventadas)
    let presStr = "";
    if (!chatJid.endsWith("@g.us") && !chatJid.endsWith("@newsletter")) {
      const pAlt = lidToJid.get(chatJid) || jidToLid.get(chatJid);
      const pInfo = presenceMap.get(chatJid) || (pAlt ? presenceMap.get(pAlt) : null);
      if (pInfo) {
        if (pInfo.status === "composing") {
          presStr = "Escribiendo...";
        } else if (pInfo.status === "recording") {
          presStr = "Grabando audio...";
        } else if (pInfo.status === "available" && pInfo.t > 0 && (Date.now() - pInfo.t < 35000)) {
          presStr = "En linea";
        } else if (pInfo.lastSeen) {
          presStr = formatearUltimaVez(pInfo.lastSeen);
        }
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
        let restringido = false;
    if (chatJid.endsWith("@newsletter")) {
      restringido = true;
    } else if (chatJid.endsWith("@g.us")) {
      restringido = await obtenerPermisosGrupo(chatJid);
    }
    return res.end(JSON.stringify({ chat: chatJid, presencia: presStr, soloAdmins: Boolean(restringido), mensajes: msgs }));
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

  // Endpoint de Stickers Nativo One UI: entrega 64x64 RGB565 (8192 bytes) Little-Endian
  if (pathname === "/api/sticker" && req.method === "GET") {
    const msgId = parsedUrl.query.id;
    if (!msgId) { res.writeHead(400); return res.end(); }
    try {
      const safeId = msgId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const rawPath = path.join(stickersFolder, `${safeId}.raw`);
      if (fs.existsSync(rawPath)) {
        const rawBuf = fs.readFileSync(rawPath);
        if (rawBuf.length === 64 * 64 * 2) {
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": rawBuf.length,
            "Cache-Control": "public, max-age=604800"
          });
          return res.end(rawBuf);
        }
      }
      const rawMsg = rawMediaMap.get(msgId);
      if (!rawMsg) { res.writeHead(404); return res.end("Sticker no en memoria"); }
      if (!sharp) { res.writeHead(503); return res.end("Sharp no disponible"); }

      const mediaBuf = await downloadMediaMessage(rawMsg, "buffer", {}, {
        logger: pino({ level: "silent" }),
        reuploadRequest: sock?.updateMediaMessage
      });
      if (!mediaBuf) { res.writeHead(404); return res.end("Descarga fallida"); }
      try { fs.writeFileSync(path.join(stickersFolder, `${safeId}.webp`), mediaBuf); } catch (_) {}

      const resObj = await sharp(mediaBuf, { page: 0 })
        .resize(64, 64, { fit: "contain", background: { r: 19, g: 27, b: 36, alpha: 1 } })
        .flatten({ background: { r: 19, g: 27, b: 36 } })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const data = resObj.data;
      const channels = resObj.info.channels || 3;
      const rgb565 = Buffer.alloc(64 * 64 * 2);
      for (let i = 0; i < 64 * 64; i++) {
        const r = data[i * channels];
        const g = data[i * channels + 1];
        const b = data[i * channels + 2];
        const c16 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
        rgb565.writeUInt16LE(c16, i * 2);
      }
      fs.writeFileSync(rawPath, rgb565);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": rgb565.length,
        "Cache-Control": "public, max-age=604800"
      });
      return res.end(rgb565);
    } catch (se) {
      console.error("[Sticker] Error procesando sticker:", se.message);
      res.writeHead(500); return res.end();
    }
  }

  // Endpoint de Fotos y Portadas de Video One UI: entrega 480x320 RGB565 o JPEG para galeria
  
  // Endpoint de QR para vinculacion nativa en pantalla ESP32
  if (pathname === "/api/qr" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      conectado: isConnected,
      qr: isConnected ? "" : (rawQR || "")
    }));
  }

  if (pathname === "/api/foto" && req.method === "GET") {
    const msgId = parsedUrl.query.id;
    const modo = parsedUrl.query.modo || "full"; // "full" (480x320 RGB565) o "jpg" (JPEG para Galería)
    if (!msgId) { res.writeHead(400); return res.end("Falta id"); }
    try {
      const safeId = msgId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const rawPath = path.join(photosFolder, `${safeId}_${modo}.raw`);
      const jpgPath = path.join(photosFolder, `${safeId}.jpg`);

      if (modo === "jpg" && fs.existsSync(jpgPath)) {
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=604800"
        });
        return fs.createReadStream(jpgPath).pipe(res);
      }

      if (modo === "full" && fs.existsSync(rawPath)) {
        const rawBuf = fs.readFileSync(rawPath);
        if (rawBuf.length === 480 * 320 * 2) {
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": rawBuf.length,
            "Cache-Control": "public, max-age=604800"
          });
          return res.end(rawBuf);
        }
      }

      const rawMsg = rawMediaMap.get(msgId);
      if (!rawMsg) { res.writeHead(404); return res.end("Foto no en memoria"); }
      if (!sharp) { res.writeHead(503); return res.end("Sharp no disponible"); }

      let inner = rawMsg.message;
      if (inner?.ephemeralMessage?.message) inner = inner.ephemeralMessage.message;
      if (inner?.viewOnceMessage?.message) inner = inner.viewOnceMessage.message;
      if (inner?.viewOnceMessageV2?.message) inner = inner.viewOnceMessageV2.message;
      if (inner?.documentWithCaptionMessage?.message) inner = inner.documentWithCaptionMessage.message;

      let mediaBuf = null;
      if (inner?.videoMessage?.jpegThumbnail) {
        mediaBuf = Buffer.from(inner.videoMessage.jpegThumbnail);
      } else {
        mediaBuf = await downloadMediaMessage(rawMsg, "buffer", {}, {
          logger: pino({ level: "silent" }),
          reuploadRequest: sock?.updateMediaMessage
        });
      }

      if (!mediaBuf) { res.writeHead(404); return res.end("Descarga fallida"); }

      // 1. Guardar copia en JPEG para la Galería si se pide o para cache
      if (!fs.existsSync(jpgPath) || modo === "jpg") {
        const jpgBuf = await sharp(mediaBuf)
          .resize(480, 320, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85, progressive: false })
          .toBuffer();
        fs.writeFileSync(jpgPath, jpgBuf);
        if (modo === "jpg") {
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": jpgBuf.length,
            "Cache-Control": "public, max-age=604800"
          });
          return res.end(jpgBuf);
        }
      }

      // 2. Generar formato directo RGB565 Little-Endian (480x320 = 307200 bytes)
      const resObj = await sharp(mediaBuf)
        .resize(480, 320, { fit: "contain", background: { r: 9, g: 13, b: 18, alpha: 1 } })
        .flatten({ background: { r: 9, g: 13, b: 18 } })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const data = resObj.data;
      const channels = resObj.info.channels || 3;
      const rgb565 = Buffer.alloc(480 * 320 * 2);
      for (let i = 0; i < 480 * 320; i++) {
        const r = data[i * channels];
        const g = data[i * channels + 1];
        const b = data[i * channels + 2];
        const c16 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
        rgb565.writeUInt16LE(c16, i * 2);
      }

      fs.writeFileSync(rawPath, rgb565);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": rgb565.length,
        "Cache-Control": "public, max-age=604800"
      });
      return res.end(rgb565);
    } catch (fe) {
      console.log(`[Foto] Error al procesar ${msgId}:`, fe.message);
      res.writeHead(500);
      return res.end();
    }
  }

  // Endpoint de Audios / Notas de Voz: entrega 16 kHz Mono WAV PCM
  if (pathname === "/api/audio" && req.method === "GET") {
    const msgId = parsedUrl.query.id;
    if (!msgId) { res.writeHead(400); return res.end(); }
    try {
      const safeId = msgId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const wavPath = path.join(audioFolder, `${safeId}.wav`);
      if (fs.existsSync(wavPath)) {
        const wavStat = fs.statSync(wavPath);
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": wavStat.size,
          "Cache-Control": "public, max-age=604800"
        });
        const stream = fs.createReadStream(wavPath);
        return stream.pipe(res);
      }
      const rawMsg = rawMediaMap.get(msgId);
      if (!rawMsg) { res.writeHead(404); return res.end("Audio no en memoria"); }

      const mediaBuf = await downloadMediaMessage(rawMsg, "buffer", {}, {
        logger: pino({ level: "silent" }),
        reuploadRequest: sock?.updateMediaMessage
      });
      if (!mediaBuf) { res.writeHead(404); return res.end("Descarga fallida"); }

      const oggPath = path.join(audioFolder, `${safeId}.ogg`);
      fs.writeFileSync(oggPath, mediaBuf);

      execFile("ffmpeg", ["-y", "-i", oggPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath], (err) => {
        try { fs.unlinkSync(oggPath); } catch (e) {}
        if (err || !fs.existsSync(wavPath)) {
          console.error("[Audio] Error transcoding con ffmpeg:", err?.message);
          res.writeHead(500); return res.end("Fallo transcodificacion");
        }
        const wavStat = fs.statSync(wavPath);
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": wavStat.size,
          "Cache-Control": "public, max-age=604800"
        });
        const stream = fs.createReadStream(wavPath);
        stream.pipe(res);
      });
      return;
    } catch (ae) {
      console.error("[Audio] Error procesando audio:", ae.message);
      res.writeHead(500); return res.end();
    }
  }

  // API Enviar mensaje
  if (pathname === "/api/enviar" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        let { chat, texto } = JSON.parse(body);
        const myJid = myNumber ? `${myNumber}@s.whatsapp.net` : (sock?.user?.id ? jidNormalizedUser(sock.user.id) : "51933961359@s.whatsapp.net");
        const myLidStr = myLid || "75798220378356@lid";
        
        // Normalizacion estricta para mensajes a uno mismo ("Mensajes Guardados (Tu)")
        // Usar SIEMPRE jidNormalizedUser para que WhatsApp E2EE lo entregue al telefono primario
        const isSelf = (chat === myLidStr || chat === "75798220378356@lid" || 
                        (myNumber && chat && chat.includes(myNumber) && !chat.endsWith("@g.us")) ||
                        (sock?.user?.id && chat && chat.includes(jidNormalizedUser(sock.user.id).split("@")[0])));
        
        if (isSelf) {
          chat = jidNormalizedUser(sock?.user?.id || myJid);
        } else {
          chat = jidNormalizedUser(chat);
        }

        if (!chat || !texto || !sock) {
          res.writeHead(400); return res.end();
        }

        if (chat.endsWith("@g.us")) {
          const restringido = await obtenerPermisosGrupo(chat);
          if (restringido) {
            res.writeHead(403, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: "Solo administradores pueden enviar mensajes en este grupo" }));
          }
        }
        let sent;
        let isStk = false;
        const stkMatch = (typeof texto === "string") ? texto.match(/^\[Sticker:(.+)\]$/) : null;
        if (stkMatch) {
          isStk = true;
          const stkId = stkMatch[1].replace(/[^a-zA-Z0-9_-]/g, "_");
          const webpPath = path.join(stickersFolder, `${stkId}.webp`);
          const rawPath = path.join(stickersFolder, `${stkId}.raw`);
          if (fs.existsSync(webpPath)) {
            sent = await sock.sendMessage(chat, { sticker: fs.readFileSync(webpPath) });
          } else if (rawMediaMap.has(stkId)) {
            try {
              const rawMsg = rawMediaMap.get(stkId);
              const mediaBuf = await downloadMediaMessage(rawMsg, "buffer", {}, {
                logger: pino({ level: "silent" }),
                reuploadRequest: sock?.updateMediaMessage
              });
              if (mediaBuf) {
                try { fs.writeFileSync(webpPath, mediaBuf); } catch (_) {}
                sent = await sock.sendMessage(chat, { sticker: mediaBuf });
              }
            } catch (_) {}
          }
          if (!sent && fs.existsSync(rawPath) && sharp) {
            try {
              const rawBuf = fs.readFileSync(rawPath);
              const rgbaBuf = Buffer.alloc(64 * 64 * 4);
              for (let i = 0; i < 64 * 64; i++) {
                const c16 = rawBuf.readUInt16LE(i * 2);
                const r = ((c16 >> 11) & 0x1F) * 255 / 31;
                const g = ((c16 >> 5) & 0x3F) * 255 / 63;
                const b = (c16 & 0x1F) * 255 / 31;
                rgbaBuf[i * 4] = Math.round(r);
                rgbaBuf[i * 4 + 1] = Math.round(g);
                rgbaBuf[i * 4 + 2] = Math.round(b);
                rgbaBuf[i * 4 + 3] = 255;
              }
              const webpBuf = await sharp(rgbaBuf, { raw: { width: 64, height: 64, channels: 4 } }).webp().toBuffer();
              sent = await sock.sendMessage(chat, { sticker: webpBuf });
            } catch (_) {}
          }
          if (!sent) {
            sent = await sock.sendMessage(chat, { text: "[Sticker]" });
          }
        } else {
          sent = await sock.sendMessage(chat, { text: texto });
        }
        const displayTxt = isStk ? "[Sticker]" : texto;
        if (sent?.key?.id) {
          allMessagesMap.set(sent.key.id, sent.message || { conversation: texto });
        }
        const ts = Math.floor(Date.now() / 1000);
        const timeStr = formatearHoraMensaje(ts);
        const timeRel = formatearHora(ts);

        const newMsgItem = {
          id: sent.key.id,
          fromMe: true,
          sender: myName || "Tú",
          text: displayTxt,
          time: timeStr,
          timestamp: ts,
          status: 2,
          read: false
        };

        if (!messagesCache.has(chat)) messagesCache.set(chat, []);
        messagesCache.get(chat).push(newMsgItem);
        if (messagesCache.get(chat).length > 50) messagesCache.get(chat).shift();

        const alt = lidToJid.get(chat) || jidToLid.get(chat);
        if (alt) {
          if (!messagesCache.has(alt)) messagesCache.set(alt, []);
          messagesCache.get(alt).push(newMsgItem);
          if (messagesCache.get(alt).length > 50) messagesCache.get(alt).shift();
        }

        if (chatsCache.has(chat)) {
          const c = chatsCache.get(chat);
          c.lastMsg = displayTxt;
          c.time = timeRel;
          c.timestamp = ts;
          c.fromMe = true;
          c.unread = 0;
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

  // API Enviar Nota de Voz oficial (PTT)
  if (pathname === "/api/enviar_audio" && req.method === "POST") {
    const chat = parsedUrl.query.chat;
    if (!chat || !sock) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Falta parametro chat o no conectado" }));
    }
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const audioBuf = Buffer.concat(chunks);
        if (audioBuf.length < 100) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Audio vacio o corrupto" }));
        }

        // Transcodificar WAV (16kHz PCM) a Ogg Opus para WhatsApp PTT
        const tmpId = Date.now() + "_" + Math.floor(Math.random() * 10000);
        const inWav = path.join(audioFolder, `in_${tmpId}.wav`);
        const outOgg = path.join(audioFolder, `out_${tmpId}.ogg`);
        fs.writeFileSync(inWav, audioBuf);

        const transcodeToOpus = (codec) => new Promise((resolve, reject) => {
          execFile("ffmpeg", ["-y", "-i", inWav, "-c:a", codec, "-b:a", "32k", "-vbr", "on", "-application", "voip", outOgg], (err) => {
            if (err) return reject(err);
            if (!fs.existsSync(outOgg) || fs.statSync(outOgg).size === 0) return reject(new Error("Ogg vacio"));
            resolve(fs.readFileSync(outOgg));
          });
        });

        let oggBuf;
        try {
          oggBuf = await transcodeToOpus("libopus");
        } catch (e1) {
          console.warn("[Audio] Reintentando transcode con codec opus...");
          try {
            oggBuf = await transcodeToOpus("opus");
          } catch (e2) {
            console.error("[Audio] Fallo transcode ffmpeg:", e2.message);
            oggBuf = audioBuf;
          }
        } finally {
          try { if (fs.existsSync(inWav)) fs.unlinkSync(inWav); } catch (_) {}
          try { if (fs.existsSync(outOgg)) fs.unlinkSync(outOgg); } catch (_) {}
        }

        const myJid = myNumber ? `${myNumber}@s.whatsapp.net` : (sock?.user?.id ? jidNormalizedUser(sock.user.id) : "51933961359@s.whatsapp.net");
        const myLidStr = myLid || "75798220378356@lid";
        const isSelf = (chat === myLidStr || chat === "75798220378356@lid" || 
                        (myNumber && chat && chat.includes(myNumber) && !chat.endsWith("@g.us")) ||
                        (sock?.user?.id && chat && chat.includes(jidNormalizedUser(sock.user.id).split("@")[0])));
        const targetChat = isSelf ? jidNormalizedUser(sock?.user?.id || myJid) : jidNormalizedUser(chat);

        const isOgg = (oggBuf !== audioBuf);
        const sent = await sock.sendMessage(targetChat, {
          audio: oggBuf,
          mimetype: isOgg ? "audio/ogg; codecs=opus" : "audio/mp4",
          ptt: true
        });
        if (sent?.key?.id) {
          allMessagesMap.set(sent.key.id, sent.message);
        }

        // Guardar WAV original para que la consola EspOS pueda reproducir su propio audio de inmediato
        if (sent?.key?.id) {
          const safeAudioId = sent.key.id.replace(/[^a-zA-Z0-9_-]/g, "_");
          try {
            fs.writeFileSync(path.join(audioFolder, `${safeAudioId}.wav`), audioBuf);
          } catch (_) {}
        }

        const ts = Math.floor(Date.now() / 1000);
        const timeStr = formatearHoraMensaje(ts);
        const timeRel = formatearHora(ts);

        const newMsgItem = {
          id: sent.key.id,
          fromMe: true,
          sender: myName || "Tú",
          text: "[Nota de voz]",
          time: timeStr,
          timestamp: ts,
          status: 2,
          read: false
        };

        if (!messagesCache.has(chat)) messagesCache.set(chat, []);
        messagesCache.get(chat).push(newMsgItem);

        if (chatsCache.has(chat)) {
          const c = chatsCache.get(chat);
          c.lastMsg = "[Nota de voz]";
          c.time = timeRel;
          c.timestamp = ts;
          c.fromMe = true;
          c.unread = 0;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, id: sent.key.id }));
      } catch (e) {
        console.error("[Audio] Error:", e);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }


  // API Enviar Sticker Nativo One UI (entrega stream 64x64 RGB565 -> WebP 512x512)
  if (pathname === "/api/enviar_sticker" && req.method === "POST") {
    let chat = parsedUrl.query.chat;
    const stkId = (parsedUrl.query.id || ("stk_" + Date.now())).replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!chat || !sock) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Falta parametro chat o no conectado" }));
    }
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const rawBuf = Buffer.concat(chunks);
        if (rawBuf.length !== 64 * 64 * 2) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Sticker invalido: debe ser 64x64 RGB565 (8192 bytes)" }));
        }

        const myJid = myNumber ? `${myNumber}@s.whatsapp.net` : (sock?.user?.id ? jidNormalizedUser(sock.user.id) : "51933961359@s.whatsapp.net");
        const myLidStr = myLid || "75798220378356@lid";
        const isSelf = (chat === myLidStr || chat === "75798220378356@lid" || 
                        (myNumber && chat && chat.includes(myNumber) && !chat.endsWith("@g.us")) ||
                        (sock?.user?.id && chat && chat.includes(jidNormalizedUser(sock.user.id).split("@")[0])));
        const targetChat = isSelf ? jidNormalizedUser(sock?.user?.id || myJid) : jidNormalizedUser(chat);

        // Convertir RGB565 Little-Endian (64x64) a RGBA
        const rgbaBuf = Buffer.alloc(64 * 64 * 4);
        for (let i = 0; i < 64 * 64; i++) {
          const c16 = rawBuf.readUInt16LE(i * 2);
          const r = ((c16 >> 11) & 0x1F) * 255 / 31;
          const g = ((c16 >> 5) & 0x3F) * 255 / 63;
          const b = (c16 & 0x1F) * 255 / 31;
          rgbaBuf[i * 4] = Math.round(r);
          rgbaBuf[i * 4 + 1] = Math.round(g);
          rgbaBuf[i * 4 + 2] = Math.round(b);
          rgbaBuf[i * 4 + 3] = (c16 === 0x0000 || c16 === 0x1184) ? 0 : 255;
        }

        let webpBuf;
        if (sharp) {
          webpBuf = await sharp(rgbaBuf, { raw: { width: 64, height: 64, channels: 4 } })
            .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality: 90 })
            .toBuffer();
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Sharp no disponible para conversion" }));
        }

        const sent = await sock.sendMessage(targetChat, {
          sticker: webpBuf
        });

        // Guardar en cache del servidor
        const webpPath = path.join(stickersFolder, `${stkId}.webp`);
        const rawPath = path.join(stickersFolder, `${stkId}.raw`);
        try { fs.writeFileSync(webpPath, webpBuf); } catch (_) {}
        try { fs.writeFileSync(rawPath, rawBuf); } catch (_) {}

        if (sent?.key?.id) {
          allMessagesMap.set(sent.key.id, sent.message || { stickerMessage: {} });
          rawMediaMap.set(sent.key.id, sent);
          rawMediaMap.set(stkId, sent);
        }

        const ts = Math.floor(Date.now() / 1000);
        const timeStr = formatearHoraMensaje(ts);
        const timeRel = formatearHora(ts);

        const newMsgItem = {
          id: stkId,
          fromMe: true,
          sender: myName || "Tú",
          text: "[Sticker]",
          tipo: "sticker",
          time: timeStr,
          timestamp: ts,
          status: 2,
          read: false
        };

        if (!messagesCache.has(targetChat)) messagesCache.set(targetChat, []);
        messagesCache.get(targetChat).push(newMsgItem);
        if (messagesCache.get(targetChat).length > 50) messagesCache.get(targetChat).shift();

        if (chatsCache.has(targetChat)) {
          const c = chatsCache.get(targetChat);
          c.lastMsg = "[Sticker]";
          c.time = timeRel;
          c.timestamp = ts;
          c.fromMe = true;
          c.unread = 0;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, id: sent.key.id }));
      } catch (err) {
        console.error("[Sticker] Error enviando sticker:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[EspCHAT Bridge v2.8.2] Activo en puerto ${PORT}`);
  startWhatsApp();

  // Keep-Alive auto-ping cada 9 minutos para prevenir suspension en Render Free
  setInterval(() => {
    try {
      const sUrl = process.env.RENDER_EXTERNAL_URL || "https://espos-chat-bridge.onrender.com";
      const pingUrl = `${sUrl}/api/status`;
      const mod = pingUrl.startsWith("https") ? require("https") : require("http");
      mod.get(pingUrl, (r) => { r.on("data", () => {}); }).on("error", () => {});
    } catch (e) {}
  }, 9 * 60 * 1000);
});
if (String(PORT) !== "3000") {
  try {
    const s3000 = http.createServer(server.listeners("request")[0]);
    s3000.listen(3000, "0.0.0.0");
  } catch (e) {}
}
