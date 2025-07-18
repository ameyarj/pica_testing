import { EnhancedPicaosTestingOrchestrator } from './orchestrator';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

function setupRailwayTerminal() {
  if (process.env.RAILWAY_ENVIRONMENT) {
    console.log(chalk.blue('🚂 Detected Railway environment - setting up interactive terminal...'));
    
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
    
    process.stdin.resume();
    process.stdout.write('\x1b[?1049h');
    
    return new Promise(resolve => setTimeout(resolve, 1000));
  }
  return Promise.resolve();
}

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

  process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n\nCaught interrupt signal (Ctrl+C). Saving state and generating final report...'));
    
    if (orchestrator) {
      try {
        await orchestrator.handleInterrupt();
        console.log(chalk.green('✅ State saved successfully'));
      } catch (error) {
        console.error(chalk.red('❌ Error saving state:', error));
      }
    }
    
    setTimeout(() => {
      console.log(chalk.yellow('Exiting...'));
      process.exit(0);
    }, 3000);
  });

  try {
    await setupRailwayTerminal();
    
    orchestrator = new EnhancedPicaosTestingOrchestrator(picaSecretKey, openAIApiKey!);
    
    await orchestrator.start();

  } catch (error) {
    console.error(chalk.red.bold('\n💥 An unhandled error occurred during orchestration:'), error);
  } finally {
    if (orchestrator) {
      try {
        orchestrator.cleanup();
      } catch (cleanup_error) {
        console.error(chalk.yellow('Warning: Error during cleanup:', cleanup_error));
      }
    }
    console.log(chalk.cyan('\n👋 Enhanced test suite finished.'));
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
