import { notInArray, sql } from "drizzle-orm";
import { db } from "./client";
import { modelWeights } from "./schema/model_weights";

const seedRows = [
  {
    openrouterModelId: "minimax/minimax-m3",
    displayName: "MiniMax M3",
    weight: "1",
    category: "default_dev",
    enabled: true,
    minPlan: "free" as const,
  },
  {
    openrouterModelId: "deepseek/deepseek-chat",
    displayName: "DeepSeek V3 (Chat)",
    weight: "1",
    category: "cost_efficient",
    enabled: true,
    minPlan: "free" as const,
  },
  {
    openrouterModelId: "deepseek/deepseek-r1",
    displayName: "DeepSeek R1",
    weight: "1",
    category: "reasoning",
    enabled: true,
    minPlan: "free" as const,
  },
  {
    openrouterModelId: "openai/gpt-4o-mini",
    displayName: "OpenAI GPT-4o mini",
    weight: "1.5",
    category: "cost_efficient",
    enabled: true,
    minPlan: "free" as const,
  },
  {
    openrouterModelId: "google/gemini-2.5-flash",
    displayName: "Google Gemini 2.5 Flash",
    weight: "1.5",
    category: "cost_efficient",
    enabled: true,
    minPlan: "free" as const,
  },
];

const enabledSeedModelIds = seedRows.map((row) => row.openrouterModelId);

async function main() {
  console.log(`Seeding ${seedRows.length} model_weights rows...`);

  await db
    .insert(modelWeights)
    .values(seedRows)
    .onConflictDoUpdate({
      target: modelWeights.openrouterModelId,
      set: {
        displayName: sql`excluded.display_name`,
        weight: sql`excluded.weight`,
        category: sql`excluded.category`,
        enabled: sql`excluded.enabled`,
        minPlan: sql`excluded.min_plan`,
        updatedAt: sql`now()`,
      },
    });

  await db
    .update(modelWeights)
    .set({ enabled: false, updatedAt: sql`now()` })
    .where(notInArray(modelWeights.openrouterModelId, enabledSeedModelIds));

  console.log("Seed complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
