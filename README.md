# PicaOS Platform Testing Suite

An automated testing framework for PicaOS platform actions using AI-powered agents and dynamic knowledge refinement.

## Features

- 🤖 AI-powered automated testing of PicaOS platform actions
- 🔄 Dynamic knowledge refinement for failed actions
- 📊 Comprehensive test reporting and analysis
- 🧠 Context-aware testing with memory of previous actions
- 🔍 Automatic data extraction and verification
- 🛠️ Built-in retry mechanism with intelligent refinements

## Prerequisites

- Node.js (v14 or higher)
- TypeScript
- PicaOS API access
- OpenAI API access

## Environment Variables

Create a `.env` file in the root directory with:

```env
PICA_SECRET_KEY=your_pica_secret_key
OPENAI_API_KEY=your_openai_api_key
PICA_USER_TOKEN=your_pica_user_token
ENVIRONMENT=DEVELOPMENT
```

## Installation

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

## Project Structure

```
src/
├── agent_service.ts      # AI agent implementation
├── context_manager.ts    # Testing context management
├── interface.ts         # TypeScript interfaces
├── knowledge_refiner.ts # Knowledge refinement logic
├── main_runner.ts      # Main entry point
├── orchestrator.ts     # Test orchestration
└── pica_api_service.ts # PicaOS API interactions
```

## Usage

Run the test suite:

```bash
npx ts-node src/main_runner.ts
```

## Testing Flow

1. **Connection Selection**: Choose a platform to test
2. **Action Discovery**: Automatically fetches available actions
3. **Prioritized Testing**: Tests actions in optimal order:
   - Create operations
   - List operations
   - Get operations
   - Update operations
   - Delete operations
4. **Smart Retries**: Failed actions are retried with:
   - Knowledge refinement
   - Context-aware improvements
   - Dependency verification

## Dependencies

- `@ai-sdk/openai`: OpenAI integration
- `@mastra/core`: Core agent functionality
- `@mastra/libsql`: Database storage
- `@mastra/memory`: Agent memory management
- `@picahq/ai`: PicaOS AI integration
- Additional utilities: axios, dotenv, zod

## Error Handling

- Automatic retry mechanism for failed actions
- Knowledge refinement for common error patterns
- Context-aware recovery strategies
- Comprehensive error reporting

## Test Reports

The test suite provides detailed reports including:
- Overall success/failure statistics
- Action-specific results
- Knowledge refinement analytics
- Context usage statistics
- Recommendations for improvements

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request


## Author

Ameya Raj