import re

with open('engine/bot-core/engine-runtime.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix relative imports that point to siblings of early-bird.ts
# they now need an extra `../`
content = re.sub(r'from "\./(.*?)"', r'from "../\1"', content)
content = re.sub(r'from "\.\./(.*?)"', r'from "../../\1"', content)

# Imports from "./bot-core/index.ts" etc were already "./bot-core/...".
# After previous regex, they became "../../bot-core/..."
# Now they should be just "./..."
content = re.sub(r'from "\.\./\.\./bot-core/(.*?)"', r'from "./\1"', content)
# And the ones that were `../../bot-core/index.ts` become `./index.ts`
content = re.sub(r'from "\.\./\.\./bot-core"', r'from "./index.ts"', content)

# Rename class and options
content = content.replace("class EarlyBird ", "class EngineRuntime ")
content = content.replace("EarlyBirdRuntimeOptions", "EngineRuntimeOptions")
content = content.replace("[early-bird]", "[engine-runtime]")

with open('engine/bot-core/engine-runtime.ts', 'w', encoding='utf-8') as f:
    f.write(content)
