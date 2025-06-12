import { EnhancedPicaosTestingOrchestrator } from './orchestrator';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

async function main() {
  console.clear();
  console.log(chalk.bold.cyan(`
╔═══════════════════════════════════════════════════════════════╗
║                  PicaOS Automated Testing Suite                ║
║                        Version 2.0                             ║
╚═══════════════════════════════════════════════════════════════╝
  `));

  const picaSecretKey = process.env.PICA_SECRET_KEY;
  const openAIApiKey = process.env.OPENAI_API_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const picaUserToken = process.env.PICA_USER_TOKEN;
  
  if (!picaSecretKey) {
    console.error(chalk.red.bold("💥 FATAL ERROR: PICA_SECRET_KEY environment variable is not set."));
    console.error(chalk.red("   This key is required to use Pica SDK and OneTool."));
    process.exit(1);
  }
  
  if (!picaUserToken) {
    console.error(chalk.red.bold("💥 FATAL ERROR: PICA_USER_TOKEN environment variable is not set."));
    console.error(chalk.red("   This token is required to fetch connection and model definitions."));
    process.exit(1);
  }
  
  if (!openAIApiKey && !anthropicApiKey) {
    console.error(chalk.red.bold("💥 FATAL ERROR: No AI provider API key found."));
    console.error(chalk.red("   Set either OPENAI_API_KEY or ANTHROPIC_API_KEY in your .env file."));
    process.exit(1);
  }
  
  console.log(chalk.bold("📋 Configuration:"));
  console.log(`   • Pica SDK: ${chalk.green("✓ Configured")}`);
  console.log(`   • Pica User Token: ${chalk.green("✓ Configured")}`);
  
  if (anthropicApiKey) {
    console.log(`   • AI Provider: ${chalk.cyan("claude-sonnet-4-20250514")}`);
  } else {
    console.log(`   • AI Provider: ${chalk.yellow("GPT-4.1")}`);
    console.log(chalk.yellow("   ⚠️  Consider adding ANTHROPIC_API_KEY for better performance"));
  }
  
  console.log(`   • Test Strategy: ${chalk.green("3-Pass with Smart Dependencies")}`);
  console.log(`   • Max Retries per Action: ${chalk.green("3")}\n`);

  try {
    const orchestrator = new EnhancedPicaosTestingOrchestrator(
      picaSecretKey, 
      openAIApiKey || "" 
    );
    
    await orchestrator.start();
    
  } catch (error) {
    console.error(chalk.red.bold("\n💥 An unhandled error occurred:"), error);
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