import os

test_files = [
    "test/engine/early-bird.test.ts",
    "test/engine/geoblock-integration.test.ts",
    "test/engine/market-spawner-characterization.test.ts",
    "test/engine/session-lifecycle.test.ts",
]

for file in test_files:
    if os.path.exists(file):
        with open(file, "r", encoding="utf-8") as f:
            content = f.read()
        
        # We replace `(bot as any)._lifecycles` and `(eb as any)._lifecycles` and `(h.eb as any)._lifecycles`
        # with the equivalent `_spawner` getter.
        
        content = content.replace("._lifecycles", "._spawner.getActiveLifecycles()")
        
        with open(file, "w", encoding="utf-8") as f:
            f.write(content)
