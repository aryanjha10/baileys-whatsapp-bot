const fs = require("fs");
const path = "./outgoingQueue.json";

function loadQueue() {
  if (!fs.existsSync(path)) return [];
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function saveQueue(queue) {
  fs.writeFileSync(path, JSON.stringify(queue, null, 2));
}

function addToQueue(msg) {
  const queue = loadQueue();
  queue.push(msg);
  saveQueue(queue);
}

function getQueuedMessages() {
  return loadQueue();
}

function clearQueue() {
  saveQueue([]);
}

module.exports = {
  addToQueue,
  getQueuedMessages,
  clearQueue,
  saveQueue,
};

function loadQueue() {
  if (!fs.existsSync(path)) return [];

  try {
    const raw = fs.readFileSync(path, "utf8").trim();
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (err) {
    console.error("❌ Failed to read outgoing queue:", err.message);
    return [];
  }
}
