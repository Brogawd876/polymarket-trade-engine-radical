const fs = require('fs');
let c = fs.readFileSync('engine/early-bird.ts', 'utf-8');

// Replace `../` with `../../../TEMP_PATH/` temporarily to avoid conflicts
c = c.replace(/from "\.\.\//g, 'from "../../../TEMP_PATH/');
// Replace `./` with `../`
c = c.replace(/from "\.\//g, 'from "../');
// Replace `../../../TEMP_PATH/` with `../../`
c = c.replace(/from "\.\.\/\.\.\/\.\.\/TEMP_PATH\//g, 'from "../../');

// Replace `../bot-core/` with `./`
c = c.replace(/from "\.\.\/bot-core\//g, 'from "./');
c = c.replace(/from "\.\.\/bot-core"/g, 'from "./index.ts"');

c = c.replace(/class EarlyBird /g, 'class EngineRuntime ');
c = c.replace(/EarlyBirdRuntimeOptions/g, 'EngineRuntimeOptions');
c = c.replace(/\[early-bird\]/g, '[engine-runtime]');

fs.writeFileSync('engine/bot-core/engine-runtime.ts', c);
