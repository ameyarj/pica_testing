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
    console.error(chalk.red.bold("FATAL ERROR: PICA_SECRET_KEY environment variable is not set."));
    process.exit(1);
  }

  if (!picaUserToken) {
    console.error(chalk.red.bold("FATAL ERROR: PICA_USER_TOKEN environment variable is not set."));
    process.exit(1);
  }

  if (!openAIApiKey && !anthropicApiKey) {
    console.error(chalk.red.bold("FATAL ERROR: No AI provider API key found (OPENAI_API_KEY or ANTHROPIC_API_KEY)."));
    process.exit(1);
  }

  let orchestrator: EnhancedPicaosTestingOrchestrator | null = null;

  process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\nCaught interrupt signal (Ctrl+C). Generating final report...'));
    if (orchestrator) {
      orchestrator.handleInterrupt(); 
    }
    process.exit(0); 
  });

  try {
    orchestrator = new EnhancedPicaosTestingOrchestrator(picaSecretKey, openAIApiKey!);
    
    await orchestrator.start();

  } catch (error) {
    console.error(chalk.red.bold('\n💥 An unhandled error occurred during orchestration:'), error);
  } finally {
    console.log(chalk.blue('\nTest suite finished. Generating final summary...'));
    if (orchestrator) {
        orchestrator.handleInterrupt(); 
    }
  }
}

process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red.bold('\n💥 Unhandled Promise Rejection:'), reason);
  process.exit(1);
});

main().catch(error => {
  console.error(chalk.red.bold("💥 A fatal error occurred in the main function:"), error);
  process.exit(1);
});