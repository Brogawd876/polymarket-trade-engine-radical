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
        
        content = content.replace("._tick()", ".tickOnce()")
        
        with open(file, "w", encoding="utf-8") as f:
            f.write(content)
