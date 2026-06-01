import re

with open("engine/bot-core/market-spawner.ts", "r") as f:
    code = f.read()

# Add missing shutdown checks at the end of _tick()
shutdown_checks = """
    // Process completed lifecycles
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
"""

code = code.replace(
"""    // Process completed lifecycles
    for (const slug of done) {
      const lifecycle = this._lifecycles.get(slug);
      if (!lifecycle) continue;
      
      this._opts.onLifecycleDone(slug, lifecycle);
      
      this._lifecycles.delete(slug);
      this._completedSlugs.add(slug);
    }""", shutdown_checks)

# Add onRoundsExhausted to Options
code = code.replace(
"""  onLifecycleDone: (slug: string, lifecycle: MarketLifecycle) => void;
  onTerminalError: (slug: string, error: TerminalAccessError) => void;
}""",
"""  onLifecycleDone: (slug: string, lifecycle: MarketLifecycle) => void;
  onTerminalError: (slug: string, error: TerminalAccessError) => void;
  onRoundsExhausted: () => void;
}"""
)

# Fix userChannelFactory instead of userChannel instance
code = code.replace("userChannel: UserChannel;", "userChannelFactory: () => UserChannel;")
code = code.replace("userChannel: this._opts.userChannel,", "userChannel: this._opts.userChannelFactory(),")


with open("engine/bot-core/market-spawner.ts", "w") as f:
    f.write(code)

with open("engine/early-bird.ts", "r") as f:
    eb_code = f.read()

eb_code = eb_code.replace("userChannel: this._userChannelFactory!(),", "userChannelFactory: this._userChannelFactory!,")

on_rounds_exhausted = """        onTerminalError: (slug, err) => {
          this._startShutdown("Terminal Access Error");
        },
        onRoundsExhausted: () => {
          this._startShutdown(`All ${this._rounds} round(s) complete.`);
        }"""
eb_code = eb_code.replace("""        onTerminalError: (slug, err) => {
          this._startShutdown("Terminal Access Error");
        }""", on_rounds_exhausted)

with open("engine/early-bird.ts", "w") as f:
    f.write(eb_code)
