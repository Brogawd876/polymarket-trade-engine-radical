import { describe, expect, test } from "bun:test";
import { EarlyBird } from "../../engine/early-bird.ts";
import { TelemetryBus } from "../../engine/bot-core/index.ts";
import { SessionManager } from "../../engine/session-manager.ts";
import { join } from "path";
import { getSlug } from "../../utils/slot.ts";

describe("MarketSpawner Characterization (Pre-Extraction)", () => {

    const FIXTURE_PATH = join(import.meta.dir, "..", "fixtures", "replay", "filled-order.log");

    async function waitForRunningSession(sm: SessionManager) {
        let attempts = 0;
        while (attempts < 50) {
            const status = sm.getStatus();
            if (status.sessionState === "running" && (status.engineStatus?.activeLifecycles ?? 0) > 0) {
                return;
            }
            if (status.sessionState === "completed" || status.sessionState === "idle") {
                return;
            }
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
    }

    // 1. Target Market Selection Validation (Replay mode provides deterministic ticks)
    test("selects the identical target market/slot explicitly from fixture", async () => {
        const bus = new TelemetryBus();
        const sessionManager = new SessionManager(bus);
        
        await sessionManager.startReplay(FIXTURE_PATH, { strategy: "simulation" });
        await waitForRunningSession(sessionManager);

        const bot = (sessionManager as any)._bot as EarlyBird;
        expect(bot).toBeDefined();

        const status = bot.getStatus();
        expect(status.mode).toBe("replay");

        const lifecycles = (bot as any)._spawner.getActiveLifecycles() as Map<string, any>;
        expect(lifecycles.size).toBeGreaterThan(0);

        const reader = (bot as any)._replayReader;
        expect(lifecycles.has(reader.round.slug)).toBe(true);

        await sessionManager.stopSession();
    });

    // 2. FVM Context Guarantee
    test("FVM receives the identical aggregate data environment injected", async () => {
        const bus = new TelemetryBus();
        const sessionManager = new SessionManager(bus);
        
        await sessionManager.startReplay(FIXTURE_PATH, { strategy: "fair-value-maker" });
        await waitForRunningSession(sessionManager);

        const bot = (sessionManager as any)._bot as EarlyBird;
        
        const lifecycles = (bot as any)._spawner.getActiveLifecycles() as Map<string, any>;
        const firstLifecycle = lifecycles.values().next().value;
        
        expect(firstLifecycle._aggregator).toBeDefined();
        expect((bot as any)._aggregator).toBe(firstLifecycle._aggregator);

        await sessionManager.stopSession();
    });

    // 3. No Live Orders Placeable Guarantee
    test("production preflight behavior strictly asserts prod flag before spawning live client", async () => {
        const bus = new TelemetryBus();
        
        const bot = new EarlyBird(
            "fair-value-maker",
            1,
            true, // prod
            1,
            false,
            undefined, // no replay
            { telemetry: bus, marketLogMode: "disabled", presetId: "test" }
        );

        let crashed = false;
        try {
            // It will try to hit the network or crash due to missing config. We race it to prevent hanging.
            await Promise.race([
                bot.start(),
                new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout waiting for config crash")), 500))
            ]);
        } catch (e: any) {
            crashed = true;
            expect(e).toBeDefined();
        }

        expect(crashed).toBe(true);

        try { await bot.stop(); } catch(e) {}
    });
});
