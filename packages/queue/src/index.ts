import { env } from "@codecrawler/shared";
import { Queue } from "bullmq";
import IORedis from "ioredis";

export const QUEUE_NAMES = {
  reviews: "reviews",
  security: "security",
  email: "email",
  webhooks: "webhooks",
  payments: "payments",
  scheduled: "scheduled",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export function makeQueue(name: string): Queue {
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return new Queue(name, { connection: connection as never });
}
