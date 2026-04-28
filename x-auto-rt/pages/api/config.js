const { getState, updateState } = require("../../lib/state");
const { startWorker, stopWorker } = require("../../lib/worker");

export default async function handler(req, res) {
  if (req.method === "GET") {
    const state = getState();
    res.status(200).json(state);
  } else if (req.method === "POST") {
    const { enabled, targetUserId } = req.body;
    const state = updateState({ enabled, targetUserId });

    if (enabled) {
      startWorker();
    } else {
      stopWorker();
    }

    res.status(200).json(state);
  } else {
    res.status(405).json({ error: "Method not allowed" });
  }
}
