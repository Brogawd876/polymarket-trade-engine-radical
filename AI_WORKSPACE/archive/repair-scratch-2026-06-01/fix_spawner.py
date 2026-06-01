import re

with open("engine/bot-core/market-spawner.ts", "r") as f:
    code = f.read()

if "onRoundsExhausted" not in code:
    code = code.replace(
"""  onLifecycleDone: (slug: string, lifecycle: MarketLifecycle) => void;
  onTerminalError: (slug: string, error: TerminalAccessError) => void;
}""",
"""  onLifecycleDone: (slug: string, lifecycle: MarketLifecycle) => void;
  onTerminalError: (slug: string, error: TerminalAccessError) => void;
  onRoundsExhausted: () => void;
}"""
    )

if "onRoundsExhausted()" not in code:
    code = code.replace(
"""    // Process completed lifecycles
    for (const slug of done) {
      const lifecycle = this._lifecycles.get(slug);
      if (!lifecycle) continue;
      
      this._opts.onLifecycleDone(slug, lifecycle);
      
      this._lifecycles.delete(slug);
      this._completedSlugs.add(slug);
    }
  }""",
"""    // Process completed lifecycles
    for (const slug of done) {
      const lifecycle = this._lifecycles.get(slug);
      if (!lifecycle) continue;
      
      this._opts.onLifecycleDone(slug, lifecycle);
      
      this._lifecycles.delete(slug);
      this._completedSlugs.add(slug);
    }

    if (!this._shuttingDown && roundsExhausted && this._lifecycles.size === 0) {
      this._opts.onRoundsExhausted();
    }
  }"""
    )

with open("engine/bot-core/market-spawner.ts", "w") as f:
    f.write(code)

with open("engine/early-bird.ts", "r") as f:
    eb_code = f.read()

if "onRoundsExhausted" not in eb_code:
    eb_code = eb_code.replace(
"""        onTerminalError: (slug, err) => {
          this._startShutdown("Terminal Access Error");
        }""",
"""        onTerminalError: (slug, err) => {
          this._startShutdown("Terminal Access Error");
        },
        onRoundsExhausted: () => {
          this._startShutdown(`All ${this._rounds} round(s) complete.`);
        }"""
    )

with open("engine/early-bird.ts", "w") as f:
    f.write(eb_code)

