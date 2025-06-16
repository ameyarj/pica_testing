import { EnhancedPicaosTestingOrchestrator } from './orchestrator';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

async function main() {
  const picaSecretKey = process.env.PICA_SECRET_KEY;
  const openAIApiKey = process.env.OPENAI_API_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const picaUserToken = process.env.PICA_USER_TOKEN;
  
  if (!picaSecretKey) {
    process.stderr.write("FATAL ERROR: PICA_SECRET_KEY environment variable is not set.\n");
    process.exit(1);
  }
  
  if (!picaUserToken) {
    process.stderr.write("FATAL ERROR: PICA_USER_TOKEN environment variable is not set.\n");
    process.exit(1);
  }
  
  if (!openAIApiKey && !anthropicApiKey) {
    process.stderr.write("FATAL ERROR: No AI provider API key found.\n");
    process.exit(1);
  }

  try {
    const orchestrator = new EnhancedPicaosTestingOrchestrator(
      picaSecretKey, 
      openAIApiKey || "" 
    );
    
    await orchestrator.start();
    
    console.log("\nTest suite completed. Check logs directory for detailed results.");
    
  } catch (error) {
    process.stderr.write(`\nAn unhandled error occurred: ${error}\n`);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log(chalk.yellow('\n\n⚠️  Test suite interrupted by user.'));
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red.bold('\n💥 Unhandled Promise Rejection:'), reason);
  process.exit(1);
});

main().catch(error => {
  console.error(chalk.red.bold("💥 Fatal error in main execution:"), error);
  process.exit(1);
});