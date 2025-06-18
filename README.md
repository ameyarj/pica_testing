# PicaOS Automated Testing Suite v2.0

An intelligent testing framework that automatically tests all API actions across multiple platforms integrated with PicaOS. The system uses advanced AI models to understand dependencies, generate adaptive prompts, and ensure comprehensive testing coverage with detailed reporting.

## 🚀 Key Features

### **2-Pass Smart Testing Strategy**
1. **Pass 1**: Initial execution leveraging an AI-generated dependency graph to run actions in an optimal order
2. **Pass 2**: A targeted retry pass for failed actions, using enhanced context gathered from successful runs and refined knowledge

### **Intelligent Dependency Analysis**
- Uses AI to automatically detect action dependencies (e.g., a `create` action must precede an `update`)
- Generates an optimized execution plan with parallelizable groups to increase efficiency
- Includes a robust rule-based fallback mechanism if AI analysis is not possible

### **Adaptive Prompt Generation**
- Dynamically creates prompts for the AI agent based on the context, action type, and attempt history
- Switches between `conversational`, `technical`, `step-by-step`, and `contextual` strategies to overcome failures
- Learns from previous agent responses to refine prompts for subsequent attempts

### **Automated Knowledge Refinement**
- Analyzes execution errors and automatically suggests and applies improvements
- Saves successfully refined knowledge to the `knowledge/` directory
- Displays a color-coded `diff` of knowledge changes for transparency

### **Comprehensive Context Management**
- Maintains a session-aware context, tracking all created resources and their extracted IDs
- Automatically injects required IDs and resource data into subsequent dependent actions

### **Detailed Logging & Cost Reporting**
- Generates detailed JSON logs and human-readable Markdown summary reports
- Includes total estimated cost, token usage per AI model, and success/failure rates per platform

## 📋 Prerequisites

- Node.js v18+ and npm
- `ts-node` installed globally (`npm install -g ts-node`) or available via npx
- A PicaOS account with API access
- **Pica User Token** obtained from your PicaOS dashboard
- **AI Provider API Keys**:
  - **Anthropic API Key** (for Claude 4 Sonnet) - recommended
  - **OpenAI API Key** (for GPT-4o/GPT-4.1) - alternative

## 🔧 Installation

1. **Clone the repository:**
    ```bash
    git clone <your-repo-url>
    cd <repository-folder>
    ```

2. **Install dependencies:**
    ```bash
    npm install
    ```

3. **Create a `.env` file:**
    ```env
    # Required - PicaOS Credentials
    PICA_SECRET_KEY=your_pica_secret_key
    PICA_USER_TOKEN=your_pica_user_token

    # AI Provider (at least one is required)
    ANTHROPIC_API_KEY=your_anthropic_api_key  # Recommended
    OPENAI_API_KEY=your_openai_api_key        # Alternative
    ```

## 🏃 Running the Test Suite

```bash
npx ts-node src/main_runner.ts
```

## 📁 Project Structure

```
src/
├── orchestrator.ts            # Main orchestrator managing the 2-pass testing strategy
├── agent_service.ts          # Service to interact with AI models
├── dependency_analyzer.ts     # Analyzes action dependencies
├── prompt_generator.ts       # Generates adaptive prompts
├── knowledge_refiner.ts      # Refines action knowledge
├── context_manager.ts        # Manages contextual data
├── pica_api_service.ts       # Interacts with the PicaOS API
├── execution_logger.ts       # Handles logging and reporting
├── enhanced_model_selector.ts # Selects the best AI model
├── path_resolver.ts          # Resolves dynamic URL parameters
├── url_validator.ts          # Validates and fixes URLs
├── interface.ts             # Core TypeScript definitions
└── main_runner.ts           # Application entry point
```

## 🎯 How It Works

1. **Platform Selection**: Choose from available PicaOS platforms
2. **Dependency Analysis**: AI-powered analysis of action dependencies
3. **Two-Pass Execution**:
   - **Pass 1**: Initial execution following dependency graph
   - **Pass 2**: Context-enhanced retry of failed actions
4. **Reporting**: Detailed summary reports in `logs/` directory

## 🧠 AI Model Support

- **claude-sonnet-4-20250514**: Default model (requires `ANTHROPIC_API_KEY`)
- **gpt-4o**: Used for large inputs (requires `OPENAI_API_KEY`)
- **gpt-4.1**: Fallback model (requires `OPENAI_API_KEY`)

## 📊 Understanding the Output

### Execution Indicators
- ✅ **SUCCESS**: Action completed successfully
- ❌ **FAILED**: Action failed with reason
- ⛔ **Permission Error**: Will not be retried
- 💡 **Refining**: Improving strategy for next attempt

### Final Summary Report
- Overall success rate and pass breakdown
- Cost estimates and AI model usage
- Failed actions and permission errors list
- Prompt strategy effectiveness

## 🚨 Troubleshooting

- **Permission Errors**: Check PicaOS integration permissions
- **Dependency Issues**: Verify create actions and dependency graph
- **High Failure Rate**: Review base knowledge for actions

## 🔐 Security

- Never commit `.env` file
- Use `.gitignore` for sensitive directories
- Rotate API keys regularly
- Handle logs containing sensitive data appropriately