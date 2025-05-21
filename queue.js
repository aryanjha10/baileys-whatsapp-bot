const fs = require("fs");
const path = "./messageQueue.json";

function loadQueue() {
  if (!fs.existsSync(path)) return [];
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (err) {
    console.error("Failed to read queue:", err.message);
    return [];
  }
}

function saveQueue(queue) {
  try {
    fs.writeFileSync(path, JSON.stringify(queue, null, 2));
  } catch (err) {
    console.error("Failed to write queue:", err.message);
  }
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
};
