const express = require("express");
const app = express();
app.use(express.json());

const qrcode = require("qrcode-terminal");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

let storeMessages = {};

const axios = require("axios");
const fs = require("fs");
const P = require("pino");
const { isWithinWorkingHours, delay } = require("./timeUtils");
const { addToQueue, getQueuedMessages, clearQueue } = require("./queue");
const outgoingQueue = require("./outgoingQueue");
const { logSentMessage, getMessagesSentInLastHour } = require("./sentLog");

//Random Delay for sending Messages
function randomDelay(min = 1200, max = 2800) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

(async () => {
  // Set up auth file to persist session
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  const WEBHOOK_URL = "https://hook.integromat.com/your-make-url";

  async function startBot() {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA version: ${version}, is latest: ${isLatest}`);

    if (fs.existsSync("storeMessages.json")) {
      storeMessages = JSON.parse(fs.readFileSync("storeMessages.json", "utf8"));
    }

    const sock = makeWASocket({
      version,
      logger: P({ level: "silent" }),
      auth: state,
      browser: ["Qasim", "MacOS", "Desktop"], // 👈 Emulate Desktop
      syncFullHistory: true, // 👈 Enable full history sync
    });

    //Store Message History
    sock.ev.on(
      "messaging-history.set",
      ({ chats, contacts, messages, syncType }) => {
        console.log("🕓 History Sync received:", {
          chats: chats.length,
          contacts: contacts.length,
          messages: messages.length,
          syncType,
        });

        for (const msg of messages) {
          const jid = msg.key.remoteJid;
          if (!storeMessages[jid]) storeMessages[jid] = [];

          storeMessages[jid].push(msg);

          // Keep only the latest 50 messages
          if (storeMessages[jid].length > 50) {
            storeMessages[jid] = storeMessages[jid]
              .slice(-50)
              .sort((a, b) => b.messageTimestamp - a.messageTimestamp);
          }

          fs.writeFileSync(
            "storeMessages.json",
            JSON.stringify(storeMessages, null, 2)
          );
          console.log("💾 Disk updated — storeMessages.json saved from sync");
        }
      }
    );

    sock.ev.process(async (events) => {
      if (events["connection.update"]) {
        const update = events["connection.update"];
        if (update.connection === "open") {
          store = sock?.store;
          console.log("📁 Store is now available");
        }
      }
    });

    // Check if number exists on WhatsApp
    app.get("/check/:number", async (req, res) => {
      const number = req.params.number;
      const jid = number + "@s.whatsapp.net";

      try {
        // 🕒 Add a 5-second delay before checking
        await delay(5000);

        const result = await sock.onWhatsApp(number);

        if (result?.length && result[0].exists) {
          return res.json({
            exists: true,
            jid: result[0].jid,
          });
        } else {
          return res.json({
            exists: false,
            reason: "Number not found on WhatsApp",
          });
        }
      } catch (err) {
        console.error("❌ WhatsApp check error:", err.message);
        res.status(500).json({ error: err.message });
      }
    });

    // 1. Send a message

    app.post("/send", async (req, res) => {
      const { number, message } = req.body;
      if (!number || !message) {
        return res.status(400).json({ error: "Missing number or message" });
      }

      const jid = number + "@s.whatsapp.net";

      // ⏰ Check working hours
      if (!isWithinWorkingHours()) {
        outgoingQueue.addToQueue({
          number,
          message,
          timestamp: new Date().toISOString(),
        });
        return res.json({ queued: true, reason: "Outside working hours" });
      }

      // ⛔ Check hourly rate limit
      const sentInLastHour = getMessagesSentInLastHour();
      if (sentInLastHour >= 15) {
        outgoingQueue.addToQueue({
          number,
          message,
          timestamp: new Date().toISOString(),
        });
        console.log(`📥 Queued (limit reached): ${number}`);
        return res.json({ queued: true, reason: "Hourly limit reached" });
      }

      // ✅ Send message with typing effect
      try {
        await sock.presenceSubscribe(jid);
        await delay(randomDelay(800, 1600));
        await sock.sendPresenceUpdate("composing", jid);
        await delay(randomDelay(1500, 3000));
        const sentMsg = await sock.sendMessage(jid, { text: message });

        logSentMessage();

        res.json({ sent: true, chat_id: sentMsg.key.remoteJid });
      } catch (err) {
        console.error(`❌ Failed to send to ${number}:`, err.message);
        res.status(500).json({ error: err.message });
      }
    });

    // 2. Retrieve chat history
    app.get("/history/:number", async (req, res) => {
      try {
        const jid = req.params.number + "@s.whatsapp.net";

        const messages = storeMessages[jid];

        if (!messages || messages.length === 0) {
          console.log(`📭 No messages found for ${jid}`);
          return res.json({ history: [] });
        }

        const history = messages.map((msg) => ({
          fromMe: msg.key.fromMe,
          text:
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            "",
          timestamp: msg.messageTimestamp,
        }));

        res.json({ history });
      } catch (err) {
        console.error("🔥 Error in /history:", err.message);
        res.status(500).json({ error: err.message });
      }
    });

    // 3. Add number to whitelist
    app.post("/whitelist", (req, res) => {
      const { number } = req.body;
      if (!number) return res.status(400).json({ error: "Number is required" });

      const whitelistPath = "./whitelist.json";
      const whitelist = JSON.parse(fs.readFileSync(whitelistPath, "utf8"));
      if (!whitelist.includes(number)) {
        whitelist.push(number);
        fs.writeFileSync(whitelistPath, JSON.stringify(whitelist, null, 2));
        return res.json({ added: true });
      }

      res.json({ alreadyExists: true });
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages }) => {
      const msg = messages[0];
      const sender = msg.key.remoteJid;

      // Ignore irrelevant messages
      if (
        !msg.message ||
        sender === "status@broadcast" ||
        !(msg.message.conversation || msg.message?.extendedTextMessage?.text)
      )
        return;

      const messageText =
        msg.message.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

      const isFromMe = msg.key.fromMe;

      console.log(`📥 Message detected (fromMe: ${isFromMe}) —`, messageText);
      console.log("📞 Sender:", sender);

      // ⏺️ Store and trim messages
      if (!storeMessages[sender]) storeMessages[sender] = [];
      storeMessages[sender].push(msg);

      if (storeMessages[sender].length > 50) {
        storeMessages[sender] = storeMessages[sender]
          .sort((a, b) => b.messageTimestamp - a.messageTimestamp)
          .slice(0, 50); // Keep 50 newest
      }

      fs.writeFileSync(
        "storeMessages.json",
        JSON.stringify(storeMessages, null, 2)
      );
      console.log("💾 Disk updated — storeMessages.json saved");

      // 🕓 Format timestamp
      const formattedTime = new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "numeric",
        hour12: true,
        timeZone: "Europe/London",
      }).format(new Date(Number(msg.messageTimestamp) * 1000));

      const payload = {
        number: sender.split("@")[0],
        message: messageText,
        timestamp: formattedTime,
      };

      // Only send webhook if NOT from you
      if (!isFromMe) {
        console.log("🕓 UK Working Hours:", isWithinWorkingHours());
        if (isWithinWorkingHours()) {
          try {
            await axios.post(WEBHOOK_URL, payload);
            console.log(`✅ Webhook sent: ${messageText}`);
          } catch (err) {
            console.error("❌ Webhook error:", err.message);
          }
        } else {
          addToQueue(payload);
          console.log(`📥 Message queued from ${payload.number}`);
        }
      }
    });

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("📱 Scan this QR to log in:\n", qr);
        qrcode.generate(qr, { small: true });
      }

      if (connection === "close") {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !==
          DisconnectReason.loggedOut;
        console.log("Connection closed. Reconnecting:", shouldReconnect);
        if (shouldReconnect) startBot();
      } else if (connection === "open") {
        console.log("✅ Connected to WhatsApp");
        store = sock.store;
        console.log("📁 Store is now available");
        replayQueuedMessages();
        replayOutgoingMessages(sock);
      }
    });

    async function replayQueuedMessages() {
      if (!isWithinWorkingHours()) return;

      const queued = getQueuedMessages();
      if (queued.length === 0) {
        console.log("🕓 No queued messages to replay");
        return;
      }

      console.log(`📤 Replaying ${queued.length} queued messages...`);
      for (const msg of queued) {
        try {
          await axios.post(WEBHOOK_URL, msg);
          await delay(1000);
        } catch (err) {
          console.error("❌ Error sending queued message:", err.message);
        }
      }

      clearQueue();
      console.log("✅ Queue cleared");
    }

    const OUTGOING_WEBHOOK_URL =
      "https://hook.integromat.com/your-outgoing-tracking-url";

    async function replayOutgoingMessages(sock) {
      // Load all queued messages
      const queued = outgoingQueue.getQueuedMessages();
      if (queued.length === 0) return;

      console.log(`📤 Replaying ${queued.length} outgoing messages...`);

      // Calculate how many messages can be sent within the hourly limit
      const remainingSends = 15 - getMessagesSentInLastHour();
      let sentCount = 0;

      for (const msg of queued) {
        // Stop if it's outside working hours
        if (!isWithinWorkingHours()) {
          console.log("⏰ Outside working hours. Stopping replay.");
          break;
        }

        // Stop if hourly message limit has been reached
        if (sentCount >= remainingSends) {
          console.log("⛔ Hourly limit reached during replay. Stopping.");
          break;
        }

        try {
          const jid = msg.number + "@s.whatsapp.net";

          // Simulate human-like typing behavior
          await sock.presenceSubscribe(jid);
          await delay(randomDelay(1000, 2000));
          await sock.sendPresenceUpdate("composing", jid);
          await delay(randomDelay(1500, 3000));

          // Send the actual message
          await sock.sendMessage(jid, { text: msg.message });

          // Notify Make.com via webhook
          await axios.post(OUTGOING_WEBHOOK_URL, {
            number: msg.number,
            timestamp: new Date().toISOString(),
          });

          // Log message timestamp for rate limit tracking
          logSentMessage();
          sentCount++;

          console.log(`✅ Sent & logged message to ${msg.number}`);
        } catch (err) {
          console.error("❌ Failed to send queued message:", err.message);
        }
      }

      // Remove only the sent messages from the queue, leave the rest
      const remainingQueue = queued.slice(sentCount);
      outgoingQueue.saveQueue(remainingQueue);

      console.log(
        `✅ Sent ${sentCount} from queue. Remaining in queue: ${remainingQueue.length}`
      );
    }
  }

  try {
    await startBot();
    const PORT = 4001; // or any other free port
    app.listen(PORT, () =>
      console.log(`🚀 HTTP API listening on port ${PORT}`)
    );
  } catch (err) {
    console.error("❌ Bot failed to start:", err.message);
  }
})();
