import fs from 'fs';
let c = fs.readFileSync('engine/early-bird.ts', 'utf-8');

// Fix relative imports up one level
c = c.replace(/from "\.\//g, 'from "../');
c = c.replace(/from "\.\.\//g, 'from "../../');

// Re-fix bot-core imports to be local
c = c.replace(/from "\.\.\/\.\.\/bot-core\//g, 'from "./');
c = c.replace(/from "\.\.\/\.\.\/bot-core"/g, 'from "./index.ts"');

// Rename class and types
c = c.replace(/class EarlyBird /g, 'class EngineRuntime ');
c = c.replace(/EarlyBirdRuntimeOptions/g, 'EngineRuntimeOptions');
c = c.replace(/\[early-bird\]/g, '[engine-runtime]');

fs.writeFileSync('engine/bot-core/engine-runtime.ts', c);
