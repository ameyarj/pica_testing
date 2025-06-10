import { PicaosTestingOrchestrator } from './orchestrator';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const picaSecretKey = process.env.PICA_SECRET_KEY;
  const openAIApiKey = process.env.OPENAI_API_KEY;
  const picaUserToken = process.env.PICA_USER_TOKEN; 
  if (!picaSecretKey) {
    console.error("💥 FATAL ERROR: PICA_SECRET_KEY environment variable is not set.");
    process.exit(1);
  }
  if (!openAIApiKey) {
    console.warn("⚠️ WARNING: OPENAI_API_KEY environment variable is not set. AI functionalities might fail.");
  }
  if (!picaUserToken) {
    console.warn("⚠️ WARNING: PICA_USER_TOKEN environment variable is not set. Pica API calls for definitions might fail.");
  }

  const orchestrator = new PicaosTestingOrchestrator(picaSecretKey, openAIApiKey || "");
  await orchestrator.start();
}

main().catch(error => {
  console.error("💥 An unhandled error reached the main execution point:", error);
  process.exit(1);
});