# Render Deployment Guide for Pica Platform Testing

## Prerequisites
- GitHub repository with your code pushed
- Render account (free tier available)
- Required environment variables values

## Step-by-Step Deployment Process

### 1. Push Your Code to GitHub
Make sure all changes are committed and pushed to your GitHub repository:
```bash
git add .
git commit -m "Prepare for Render deployment"
git push origin main
```

### 2. Create a New Service on Render
1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click "New +" and select "Background Worker"
3. Connect your GitHub repository
4. Select the repository: `pica_testing`

### 3. Configure the Service
- **Name**: `pica-platform-testing`
- **Runtime**: `Node`
- **Build Command**: `npm ci && npm run build`
- **Start Command**: `npm start`
- **Plan**: Choose based on your needs (Free tier available)

### 4. Set Environment Variables
In the Render dashboard, add these environment variables:
- `NODE_ENV` = `production`
- `PICA_SECRET_KEY` = `your_pica_secret_key`
- `PICA_USER_TOKEN` = `your_pica_user_token`
- `OPENAI_API_KEY` = `your_openai_api_key` (if using OpenAI)
- `ANTHROPIC_API_KEY` = `your_anthropic_api_key` (if using Anthropic)

### 5. Deploy
1. Click "Create Background Worker"
2. Render will automatically build and deploy your application
3. Monitor the deployment logs for any issues

## Alternative: Using render.yaml (Recommended)
The project includes a `render.yaml` file that automates the configuration:
1. In your Render dashboard, go to "Blueprint"
2. Click "New Blueprint Instance"
3. Connect your GitHub repository
4. Render will automatically detect and use the `render.yaml` configuration
5. Set the environment variables as listed above

## Local Development Scripts
- `npm run dev` - Run in development mode with ts-node
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Run the built application

## Troubleshooting
- Check the Render logs for any startup errors
- Ensure all environment variables are set correctly
- Verify your GitHub repository is up to date
- Make sure the build completes successfully

## Service Type: Background Worker
Your application is configured as a Background Worker because it's a CLI tool that runs continuously, not a web service. This is perfect for your orchestration and testing application.
