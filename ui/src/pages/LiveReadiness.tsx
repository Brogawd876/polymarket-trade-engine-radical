import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Code2, FlaskConical, Lock, Play, RefreshCw, Save, ShieldAlert } from 'lucide-react';

const API_BASE = 'http://127.0.0.1:3000/api/operator';

type StrategyModule = {
    id: string;
    label: string;
    version: string;
    description: string;
    defaultConfig: Record<string, unknown>;
    paperEligible: boolean;
    liveEligible: boolean;
    source: 'built-in' | 'custom';
    validationStatus: 'valid' | 'invalid' | 'untested';
    validationErrors: string[];
};

type StrategyPreset = {
    id: string;
    moduleId: string;
    label: string;
    config: Record<string, unknown>;
    configHash: string;
    riskProfile: 'simulation' | 'paper' | 'tiny-live';
    notes: string;
    promotionStatus: 'draft' | 'replay_candidate' | 'paper_candidate' | 'tiny_live_candidate' | 'retired';
};

type ReplayFixture = {
    path: string;
    label: string;
    replayable: boolean;
};

type Experiment = {
    id: string;
    name: string;
    state: 'queued' | 'running' | 'completed' | 'failed';
    recommendation: null | {
        id: string;
        presetId: string;
        moduleId: string;
        score: number;
        readyForPaper: boolean;
        applied: boolean;
        rationale: string[];
    };
    train?: { summary: { totalRuns: number; totalPnl: number; winRate: number | null; problems: number } };
    holdout?: { summary: { totalRuns: number; totalPnl: number; winRate: number | null; problems: number } };
    error?: string;
};

type PaperSessionEvidence = {
    id: string;
    presetId: string;
    moduleId: string;
    label: string;
    configHash: string;
    startedAtMs: number;
    endedAtMs: number;
    status: 'completed' | 'failed' | 'canceled';
    pnl: number;
    fills: number;
    blocked: number;
    problems: number;
    decisionSnapshots: number;
    verdict: 'win' | 'loss' | 'flat' | 'no_trade' | 'problem' | 'canceled' | 'failed';
};

function money(value: number | null | undefined) {
    if (value == null) return '---';
    return `${value >= 0 ? '$' : '-$'}${Math.abs(value).toFixed(2)}`;
}

function percent(value: number | null | undefined) {
    if (value == null) return '---';
    return `${Math.round(value * 100)}%`;
}

function badgeClass(ok: boolean) {
    return ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300';
}

export default function LiveReadiness() {
    const [modules, setModules] = useState<StrategyModule[]>([]);
    const [presets, setPresets] = useState<StrategyPreset[]>([]);
    const [fixtures, setFixtures] = useState<ReplayFixture[]>([]);
    const [selectedModule, setSelectedModule] = useState('simulation');
    const [presetLabel, setPresetLabel] = useState('Paper candidate');
    const [presetConfig, setPresetConfig] = useState('{}');
    const [selectedPreset, setSelectedPreset] = useState('simulation');
    const [sourceCode, setSourceCode] = useState(`export const module = {
  id: "custom-late-entry",
  evaluate(ctx, config) {
    return [];
  }
};`);
    const [validation, setValidation] = useState<string | null>(null);
    const [experiment, setExperiment] = useState<Experiment | null>(null);
    const [evidenceRows, setEvidenceRows] = useState<PaperSessionEvidence[]>([]);
    const [message, setMessage] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const replayable = useMemo(() => fixtures.filter(fixture => fixture.replayable).slice(0, 3), [fixtures]);
    const holdout = useMemo(() => fixtures.filter(fixture => fixture.replayable).slice(3, 5), [fixtures]);
    const activePreset = presets.find(preset => preset.id === selectedPreset);
    const activeEvidence = useMemo(() => evidenceRows.filter(row => row.presetId === selectedPreset), [evidenceRows, selectedPreset]);
    const hasCleanPaperEvidence = activeEvidence.some(row => row.status === 'completed' && row.problems === 0 && row.fills > 0 && row.decisionSnapshots > 0 && row.pnl >= 0);
    const hasReplayEvidence = activePreset?.promotionStatus === 'paper_candidate' || activePreset?.promotionStatus === 'tiny_live_candidate' || activePreset?.promotionStatus === 'replay_candidate';
    const hasPaperApproval = activePreset?.riskProfile === 'paper' || activePreset?.riskProfile === 'tiny-live';
    const canPromoteTinyCandidate = Boolean(activePreset && hasReplayEvidence && hasPaperApproval && hasCleanPaperEvidence && activePreset.promotionStatus === 'paper_candidate');
    const canUnlockTinyLive = activePreset?.promotionStatus === 'tiny_live_candidate' && activePreset.riskProfile === 'paper';

    useEffect(() => {
        void loadAll();
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, []);

    async function loadAll() {
        setLoading(true);
        try {
            const [moduleResponse, presetResponse, fixtureResponse, evidenceResponse] = await Promise.all([
                fetch(`${API_BASE}/strategy/modules`),
                fetch(`${API_BASE}/strategy/presets`),
                fetch(`${API_BASE}/replay-fixtures`),
                fetch(`${API_BASE}/strategy/evidence`),
            ]);
            const moduleData = await moduleResponse.json();
            const presetData = await presetResponse.json();
            const fixtureData = await fixtureResponse.json();
            const evidenceData = await evidenceResponse.json();
            const nextModules = moduleData.modules ?? [];
            const nextPresets = presetData.presets ?? [];
            setModules(nextModules);
            setPresets(nextPresets);
            setFixtures(fixtureData.files ?? []);
            setEvidenceRows(evidenceData.evidence ?? []);
            setSelectedModule(current => nextModules.some((item: StrategyModule) => item.id === current) ? current : nextModules[0]?.id ?? 'simulation');
            setSelectedPreset(current => nextPresets.some((item: StrategyPreset) => item.id === current) ? current : nextPresets[0]?.id ?? 'simulation');
        } finally {
            setLoading(false);
        }
    }

    async function validateCustomModule() {
        setValidation(null);
        const response = await fetch(`${API_BASE}/strategy/modules/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'custom-late-entry', label: 'custom late entry', sourceCode }),
        });
        const data = await response.json();
        setValidation(data.success ? 'Custom module saved as replay-only. Run replay validation before paper use.' : (data.errors ?? ['Validation failed']).join('; '));
        await loadAll();
    }

    async function savePreset() {
        let config: Record<string, unknown>;
        try {
            config = JSON.parse(presetConfig);
        } catch {
            setMessage('Preset config must be valid JSON.');
            return;
        }
        const response = await fetch(`${API_BASE}/strategy/presets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                moduleId: selectedModule,
                label: presetLabel,
                config,
                riskProfile: 'simulation',
                promotionStatus: 'replay_candidate',
                notes: 'Created from Live Readiness builder.',
            }),
        });
        const data = await response.json();
        setMessage(data.success ? `Saved preset ${data.preset.label} (${data.preset.configHash})` : data.error);
        await loadAll();
    }

    async function runExperiment() {
        if (!selectedPreset || replayable.length === 0) return;
        setMessage(null);
        const response = await fetch(`${API_BASE}/strategy-lab/experiments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Replay to paper recommendation',
                presetIds: [selectedPreset],
                files: replayable.map(fixture => fixture.path),
                holdoutFiles: holdout.map(fixture => fixture.path),
            }),
        });
        const data = await response.json();
        if (!data.success) {
            setMessage(data.error);
            return;
        }
        setExperiment(data.experiment);
        startPolling(data.experimentId);
    }

    function startPolling(id: string) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
            const response = await fetch(`${API_BASE}/strategy-lab/experiments/${id}`);
            const data = await response.json();
            if (data.success) {
                setExperiment(data.experiment);
                if (!['queued', 'running'].includes(data.experiment.state)) {
                    if (pollRef.current) clearInterval(pollRef.current);
                    pollRef.current = null;
                }
            }
        }, 1000);
    }

    async function applyRecommendation() {
        if (!experiment?.recommendation) return;
        const response = await fetch(`${API_BASE}/paper-tuning/recommendations/${experiment.recommendation.id}/apply`, { method: 'POST' });
        const data = await response.json();
        setMessage(data.success ? `Applied paper tuning preset ${data.preset.id}` : data.error);
        await loadAll();
    }

    async function promotePaperCandidate() {
        if (!selectedPreset) return;
        const response = await fetch(`${API_BASE}/strategy/presets/${encodeURIComponent(selectedPreset)}/promote-paper-candidate`, { method: 'POST' });
        const data = await response.json();
        setMessage(data.success ? `Preset ${data.preset.label} is now a tiny-live candidate.` : data.error);
        await loadAll();
    }

    async function unlockTinyLive() {
        const response = await fetch(`${API_BASE}/operator/tiny-live/unlock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ presetId: selectedPreset, operatorAck: true }),
        });
        const data = await response.json();
        setMessage(data.success ? 'Tiny-live unlocked for this preset with ultra-tiny caps.' : data.error);
        await loadAll();
    }

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-6">
            <header className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold text-slate-100 flex items-center gap-3">
                        <ShieldAlert className="w-8 h-8 text-emerald-400" />
                        Live Readiness
                    </h1>
                    <p className="text-slate-400 mt-2">Build strategy modules, promote presets, tune paper behavior, and guard tiny-live unlocks.</p>
                </div>
                <button onClick={loadAll} className="h-10 w-10 rounded border border-slate-700 bg-slate-800 inline-flex items-center justify-center text-slate-300" title="Refresh">
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </header>

            {message && <div className="rounded border border-blue-500/30 bg-blue-500/10 p-3 text-sm text-blue-200">{message}</div>}

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <section className="bg-slate-800 border border-slate-700 rounded-lg p-5 space-y-4">
                    <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2"><Code2 className="w-5 h-5 text-emerald-400" /> Strategy Builder</h2>
                    <div className="grid gap-2">
                        <label className="text-xs uppercase tracking-wider text-slate-500 font-bold">Custom TypeScript Module</label>
                        <textarea value={sourceCode} onChange={event => setSourceCode(event.target.value)} className="min-h-52 bg-slate-950 border border-slate-700 rounded p-3 text-xs font-mono text-slate-200 outline-none focus:border-emerald-500" />
                    </div>
                    <button onClick={validateCustomModule} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded font-bold text-white">Validate & Save Replay-Only Module</button>
                    {validation && <div className="text-sm text-slate-300 border-l-2 border-slate-600 pl-3">{validation}</div>}
                    <div className="grid gap-2">
                        {modules.map(module => (
                            <div key={module.id} className="flex items-center justify-between gap-3 border border-slate-700 bg-slate-900/40 rounded p-3">
                                <div>
                                    <div className="font-semibold text-slate-100">{module.label}</div>
                                    <div className="text-xs text-slate-500">{module.source} · v{module.version} · {module.description}</div>
                                </div>
                                <span className={`text-xs px-2 py-1 rounded border ${badgeClass(module.paperEligible)}`}>{module.paperEligible ? 'paper eligible' : 'replay only'}</span>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="bg-slate-800 border border-slate-700 rounded-lg p-5 space-y-4">
                    <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2"><Save className="w-5 h-5 text-emerald-400" /> Presets</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <select value={selectedModule} onChange={event => setSelectedModule(event.target.value)} className="bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200">
                            {modules.map(module => <option key={module.id} value={module.id}>{module.label}</option>)}
                        </select>
                        <input value={presetLabel} onChange={event => setPresetLabel(event.target.value)} className="bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200" />
                    </div>
                    <textarea value={presetConfig} onChange={event => setPresetConfig(event.target.value)} className="min-h-28 bg-slate-950 border border-slate-700 rounded p-3 text-xs font-mono text-slate-200" />
                    <button onClick={savePreset} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded font-bold text-white">Save Replay Candidate Preset</button>
                    <div className="grid gap-2">
                        {presets.map(preset => (
                            <button key={preset.id} onClick={() => setSelectedPreset(preset.id)} className={`text-left border rounded p-3 ${selectedPreset === preset.id ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-slate-700 bg-slate-900/40'}`}>
                                <div className="flex justify-between gap-2">
                                    <span className="font-semibold text-slate-100">{preset.label}</span>
                                    <span className="text-xs text-slate-500 font-mono">{preset.configHash}</span>
                                </div>
                                <div className="text-xs text-slate-500">{preset.moduleId} · {preset.riskProfile} · {preset.promotionStatus}</div>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="bg-slate-800 border border-slate-700 rounded-lg p-5 space-y-4">
                    <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2"><FlaskConical className="w-5 h-5 text-emerald-400" /> Experiments & Paper Tuning</h2>
                    <div className="text-sm text-slate-400">Selected preset: <span className="text-slate-100 font-semibold">{activePreset?.label ?? 'none'}</span></div>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                        <div className="rounded border border-slate-700 bg-slate-900/40 p-3">
                            <div className="text-slate-500 uppercase font-bold">Train fixtures</div>
                            <div className="text-xl font-black text-slate-100">{replayable.length}</div>
                        </div>
                        <div className="rounded border border-slate-700 bg-slate-900/40 p-3">
                            <div className="text-slate-500 uppercase font-bold">Holdout fixtures</div>
                            <div className="text-xl font-black text-slate-100">{holdout.length}</div>
                        </div>
                    </div>
                    <button onClick={runExperiment} disabled={!selectedPreset || replayable.length === 0 || experiment?.state === 'running'} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded font-bold text-white flex items-center gap-2">
                        <Play className="w-4 h-4" /> Run Experiment
                    </button>
                    {experiment && (
                        <div className="rounded border border-slate-700 bg-slate-900/40 p-4 space-y-3">
                            <div className="flex justify-between">
                                <span className="font-semibold text-slate-100">{experiment.name}</span>
                                <span className="text-xs uppercase text-blue-300">{experiment.state}</span>
                            </div>
                            {experiment.train && <div className="text-sm text-slate-300">Train: {experiment.train.summary.totalRuns} runs · {money(experiment.train.summary.totalPnl)} · {percent(experiment.train.summary.winRate)}</div>}
                            {experiment.holdout && <div className="text-sm text-slate-300">Holdout: {experiment.holdout.summary.totalRuns} runs · {money(experiment.holdout.summary.totalPnl)} · {percent(experiment.holdout.summary.winRate)}</div>}
                            {experiment.recommendation && (
                                <div className="border-l-2 border-emerald-500 pl-3">
                                    <div className="text-slate-100 font-semibold">Recommendation score {experiment.recommendation.score.toFixed(2)}</div>
                                    <div className={`inline-flex mt-1 text-xs px-2 py-1 rounded border ${badgeClass(experiment.recommendation.readyForPaper)}`}>{experiment.recommendation.readyForPaper ? 'ready for paper approval' : 'keep tuning'}</div>
                                    <div className="mt-2 grid gap-1 text-xs text-slate-400">{experiment.recommendation.rationale.map(item => <span key={item}>{item}</span>)}</div>
                                    <button onClick={applyRecommendation} disabled={!experiment.recommendation.readyForPaper || experiment.recommendation.applied} className="mt-3 px-3 py-2 rounded bg-blue-600 disabled:opacity-40 text-white font-bold text-sm">Apply Paper Tuning</button>
                                </div>
                            )}
                            {experiment.error && <div className="text-red-300 text-sm">{experiment.error}</div>}
                        </div>
                    )}
                </section>

                <section className="bg-slate-800 border border-slate-700 rounded-lg p-5 space-y-4">
                    <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2"><Lock className="w-5 h-5 text-emerald-400" /> Promotion & Tiny-Live Guard</h2>
                    <div className="grid gap-3">
                        <div className="rounded border border-slate-700 bg-slate-900/40 p-3 flex items-center justify-between">
                            <span className="text-slate-300">Replay evidence exists</span>
                            <CheckCircle2 className={`w-5 h-5 ${hasReplayEvidence ? 'text-emerald-400' : 'text-slate-600'}`} />
                        </div>
                        <div className="rounded border border-slate-700 bg-slate-900/40 p-3 flex items-center justify-between">
                            <span className="text-slate-300">Paper recommendation approved</span>
                            <CheckCircle2 className={`w-5 h-5 ${hasPaperApproval ? 'text-emerald-400' : 'text-slate-600'}`} />
                        </div>
                        <div className="rounded border border-slate-700 bg-slate-900/40 p-3 flex items-center justify-between">
                            <span className="text-slate-300">Clean paper evidence exists</span>
                            <CheckCircle2 className={`w-5 h-5 ${hasCleanPaperEvidence ? 'text-emerald-400' : 'text-slate-600'}`} />
                        </div>
                        <div className="rounded border border-slate-700 bg-slate-900/40 p-3 text-sm text-slate-300">
                            Ultra-tiny caps: $1/order | $5 exposure | $5 loss | strict feed and close-window gates.
                        </div>
                    </div>
                    <div className="rounded border border-slate-700 bg-slate-900/40 p-3">
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-sm font-semibold text-slate-200">Recent Paper Evidence</span>
                            <span className="text-xs text-slate-500">{activeEvidence.length} rows</span>
                        </div>
                        <div className="grid gap-2">
                            {activeEvidence.slice(0, 4).map(row => (
                                <div key={row.id} className="grid grid-cols-4 gap-2 text-xs text-slate-400 border border-slate-800 rounded p-2">
                                    <span className="text-slate-200">{row.verdict}</span>
                                    <span>{money(row.pnl)}</span>
                                    <span>{row.fills} fills</span>
                                    <span>{row.problems} problems</span>
                                </div>
                            ))}
                            {activeEvidence.length === 0 && <div className="text-xs text-slate-500">No paper evidence recorded for this preset yet.</div>}
                        </div>
                    </div>
                    <button onClick={promotePaperCandidate} disabled={!canPromoteTinyCandidate} className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 rounded font-bold text-white">
                        Promote to Tiny-Live Candidate
                    </button>
                    <button onClick={unlockTinyLive} disabled={!canUnlockTinyLive} className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 rounded font-bold text-white">
                        Explicitly Unlock Tiny-Live
                    </button>
                </section>
            </div>
        </div>
    );
}
