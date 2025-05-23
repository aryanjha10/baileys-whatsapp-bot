const fs = require("fs");
const path = "./sentLog.json";

function loadLog() {
  if (!fs.existsSync(path)) return [];
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (err) {
    return [];
  }
}

function saveLog(log) {
  fs.writeFileSync(path, JSON.stringify(log, null, 2));
}

function logSentMessage() {
  const log = loadLog();
  log.push(Date.now());
  saveLog(log);
}

function getMessagesSentInLastHour() {
  const log = loadLog();
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  return log.filter(ts => ts > oneHourAgo).length;
}

module.exports = {
  logSentMessage,
  getMessagesSentInLastHour
};
