import { TwitterApi } from "twitter-api-v2";

export function getTwitterClient() {
  return new TwitterApi({
    appKey: process.env.TWITTER_API_KEY || "",
    appSecret: process.env.TWITTER_API_SECRET || "",
    accessToken: process.env.TWITTER_ACCESS_TOKEN || "",
    accessSecret: process.env.TWITTER_ACCESS_SECRET || "",
  });
}

export function getReadOnlyClient() {
  return new TwitterApi(process.env.TWITTER_BEARER_TOKEN || "");
}
