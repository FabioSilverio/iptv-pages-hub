const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(process.cwd(), "data", "state.json");

function ensureStateFile() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({
        enabled: false,
        targetUserId: "",
        lastRetweetedTweetId: "",
        lastRetweetedAt: null,
        totalRetweets: 0,
      })
    );
  }
}

function getState() {
  ensureStateFile();
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function updateState(updates) {
  ensureStateFile();
  const current = getState();
  const updated = { ...current, ...updates };
  fs.writeFileSync(STATE_FILE, JSON.stringify(updated, null, 2));
  return updated;
}

module.exports = { getState, updateState };
