# PicaOS Automated Testing Suite v2.0

An intelligent testing framework that automatically tests all API actions across multiple platforms integrated with PicaOS. The system uses advanced AI models to understand dependencies, refine knowledge, and ensure comprehensive testing coverage.

## 🚀 Key Features

### **3-Pass Testing Strategy**
1. **Pass 1**: Initial execution with smart dependency ordering
2. **Pass 2**: Retry failures with enhanced context from successful actions
3. **Pass 3**: Final attempt using meta-strategies for stubborn failures

### **Intelligent Dependency Analysis**
- Automatically detects action dependencies (e.g., create before update)
- Orders actions optimally to maximize success rate
- Identifies which IDs are provided and required by each action

### **Adaptive Prompting**
- Generates human-like, contextual prompts
- Adjusts strategy based on action type and previous failures
- Learns from successful patterns

### **Knowledge Refinement**
- Automatically enhances action knowledge based on errors
- Adds context mappings and clarifications
- Preserves successful patterns for future use

### **Enhanced Context Management**
- Tracks all created resources and extracted IDs
- Automatically uses available IDs in dependent actions
- Maintains execution history for intelligent retries

## 📋 Prerequisites

- Node.js 18+ and npm
- PicaOS account with API access
- OpenAI API key (for GPT-4) or Anthropic API key (for Claude 3.5 Sonnet)
- Pica User Token (from your PicaOS dashboard)

## 🔧 Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd picaos-testing-suite
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file:
```env
# Required - PicaOS Credentials
PICA_SECRET_KEY=your_pica_secret_key
PICA_USER_TOKEN=your_pica_user_token

# AI Provider (at least one required)
ANTHROPIC_API_KEY=your_anthropic_key  # Recommended for best performance
OPENAI_API_KEY=your_openai_key        # Alternative if Anthropic not available
```

## 🏃 Running the Test Suite

Start the enhanced testing suite:
```bash
npm run start
```

For development with auto-reload:
```bash
npm run dev
```

## 📁 Project Structure

```
src/
├── enhanced_orchestrator.ts   # Main testing orchestrator with 3-pass strategy
├── agent_service.ts          # Enhanced agent with Claude/GPT-4 support
├── dependency_analyzer.ts    # Intelligent dependency analysis
├── prompt_generator.ts       # Adaptive prompt generation
├── knowledge_refiner.ts      # AI-powered knowledge enhancement
├── context_manager.ts        # Tracks resources and execution state
├── pica_api_service.ts      # PicaOS API interactions
├── interface.ts             # TypeScript interfaces
└── main_runner.ts           # Entry point with enhanced UI
```

## 🎯 How It Works

### 1. **Platform Selection**
- Fetches all available platforms from PicaOS
- User selects which platform to test
- Loads all actions for that platform

### 2. **Dependency Analysis**
- AI analyzes all actions to understand dependencies
- Creates an execution graph with parallel groups
- Identifies which actions provide/require specific IDs

### 3. **Three-Pass Execution**

#### Pass 1: Initial Smart Execution
- Executes actions in dependency order
- Uses adaptive prompting based on action type
- Extracts and stores all created IDs
- Tracks successes and failures

#### Pass 2: Context-Enhanced Retry
- Retries failed actions with full context
- Uses refined knowledge from Pass 1
- Leverages successful action data
- Applies lessons learned from errors

#### Pass 3: Meta-Strategy Final Attempt
- Generates a unified strategy for remaining failures
- Uses advanced AI reasoning across all failures
- Makes final attempts with maximum context

### 4. **Results Summary**
- Detailed breakdown by pass
- Strategy effectiveness metrics
- Actionable recommendations
- Knowledge refinement suggestions

## 🧠 AI Model Support

The suite supports both OpenAI and Anthropic models:

### Claude 3.5 Sonnet 
- Better at understanding complex dependencies
- More nuanced prompt generation
- Superior context handling
- Set `ANTHROPIC_API_KEY` in .env

### GPT-4 Turbo 
- Good general performance
- Widely available
- Set `OPENAI_API_KEY` in .env

## 📊 Understanding the Output

### Success Indicators
- 🟢 **Green**: Action succeeded
- 🟡 **Yellow**: Action succeeded with retries
- 🔵 **Blue**: Action succeeded with context
- 🔴 **Red**: Action failed after all attempts

### Execution Groups
Actions are grouped by dependencies:
- **Group 1**: Independent actions (can run in parallel)
- **Group 2**: Actions depending on Group 1
- **Group N**: Actions depending on previous groups

### Metrics Provided
- Overall success rate
- Pass-by-pass breakdown
- Most effective prompt strategies
- Knowledge refinement statistics
- Dependency failure analysis

## 🔍 Debugging

Enable verbose logging:
```bash
DEBUG=* npm run start
```

Check specific components:
```bash
DEBUG=orchestrator,agent npm run start
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📝 Best Practices

### For PicaOS Integration Teams

1. **Knowledge Quality**: Ensure action knowledge includes:
   - Clear parameter descriptions
   - Example values
   - Response format
   - Error scenarios

2. **Dependency Hints**: In action paths, use meaningful parameter names:
   - Good: `/documents/{{documentId}}/sheets`
   - Bad: `/documents/{{id}}/sheets`

3. **Action Naming**: Use clear, consistent action names:
   - `createDocument`, `getDocument`, `updateDocument`, `deleteDocument`

4. **Testing Order**: The system handles this automatically, but logical grouping helps

### For Test Suite Users

1. **Start Simple**: Test one platform at a time
2. **Review Failures**: Check the detailed error messages
3. **Update Knowledge**: Use the refinement suggestions to improve action definitions
4. **Monitor Patterns**: Look for common failure types across actions

## 🚨 Troubleshooting

### Common Issues

**"Dependencies not met" errors**
- The system detected missing prerequisites
- Check if create actions are properly defined
- Verify ID extraction is working

**"Format error" failures**
- Review the knowledge for parameter formats
- Check if the platform expects specific date/number formats
- Look at successful similar actions

**High failure rate in Pass 1**
- Normal for complex platforms
- Pass 2 and 3 will use context to improve
- Review if base knowledge needs updates

**API Rate Limits**
- Add delays between actions if needed
- Contact PicaOS support for higher limits
- Use batch operations where available


## 🔐 Security

- Never commit `.env` files
- Rotate API keys regularly
- Use environment-specific credentials
- Review action outputs for sensitive data

