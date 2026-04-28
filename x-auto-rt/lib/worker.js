const { getTwitterClient, getReadOnlyClient } = require("./twitter");
const { getState, updateState } = require("./state");

let intervalId = null;

async function checkAndRetweet() {
  const state = getState();

  if (!state.enabled || !state.targetUserId) return;

  try {
    const readOnlyClient = getReadOnlyClient();
    const tweets = await readOnlyClient.v2.userTimeline(state.targetUserId, {
      max_results: 10,
      exclude: ["replies", "retweets"],
    });

    const newTweets = tweets.data.data.filter(
      (tweet) => tweet.id !== state.lastRetweetedTweetId
    );

    if (newTweets.length > 0) {
      const writeClient = getTwitterClient();
      const latestTweet = newTweets[0];

      try {
        await writeClient.v2.retweet(
          (await writeClient.currentUser()).data.id,
          latestTweet.id
        );

        updateState({
          lastRetweetedTweetId: latestTweet.id,
          lastRetweetedAt: new Date().toISOString(),
          totalRetweets: state.totalRetweets + 1,
          lastRetweetedTweetText: latestTweet.text.substring(0, 100),
        });

        console.log(
          `[${new Date().toISOString()}] Retweet done: ${latestTweet.text.substring(0, 50)}...`
        );
      } catch (err) {
        console.error("Retweet failed:", err.message);
      }
    }
  } catch (err) {
    console.error("Check failed:", err.message);
  }
}

function startWorker() {
  if (intervalId) return;
  console.log("Auto-retweet worker started (checking every 60s)");
  checkAndRetweet();
  intervalId = setInterval(checkAndRetweet, 60000);
}

function stopWorker() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("Auto-retweet worker stopped");
  }
}

module.exports = { startWorker, stopWorker, checkAndRetweet };
