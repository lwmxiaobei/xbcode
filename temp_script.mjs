import { getSkillLoader } from './src/skills/loader.js';
import { getMcpPromptInstructions } from './src/mcp/runtime.js';

const skillLoader = getSkillLoader();
const skillDescriptions = skillLoader.getDescriptions();
const mcpSummary = getMcpPromptInstructions();

console.log('=== SYSTEM PROMPT ===');
console.log(`You are a coding agent at ${process.cwd()}. Use tools to solve tasks. Act, don't explain.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${skillDescriptions}

${mcpSummary}`);