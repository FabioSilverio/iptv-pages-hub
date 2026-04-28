const { getTwitterClient } = require("../../lib/twitter");

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const client = getTwitterClient();
    const user = await client.currentUser();
    res.status(200).json({
      connected: true,
      username: user.data.username,
      name: user.data.name,
      id: user.data.id,
    });
  } catch (err) {
    res.status(200).json({
      connected: false,
      error: err.message,
    });
  }
}
