 
import { useState, useEffect, useRef } from 'react';
import { FileText, Search, RefreshCw, ChevronRight, Terminal } from 'lucide-react';

export default function Logs() {
    const [files, setFiles] = useState<string[]>([]);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [content, setContent] = useState<string>('');
    const [loading, setLoading] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);
    const [searchTerm, setSearchTerm] = useState('');
    const scrollRef = useRef<HTMLPreElement>(null);

    useEffect(() => {
        fetch('http://127.0.0.1:3000/api/operator/logs')
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data.files)) {
                    setFiles(data.files);
                    setSelectedFile(current => {
                        if (data.files.length === 0) return null;
                        return current && data.files.includes(current) ? current : data.files[0];
                    });
                }
            })
            .catch(err => console.error("Failed to fetch log files", err));
    }, [refreshKey]);

    useEffect(() => {
        if (!selectedFile) return;
        Promise.resolve().then(() => setLoading(true));
        fetch(`http://127.0.0.1:3000/api/operator/logs/${encodeURIComponent(selectedFile)}`)
            .then(res => res.text())
            .then(text => {
                setContent(text);
                setLoading(false);
            })
            .catch(err => {
                console.error("Failed to fetch log content", err);
                setLoading(false);
            });
    }, [selectedFile, refreshKey]);

    const filteredContent = searchTerm 
        ? content.split('\n').filter(line => line.toLowerCase().includes(searchTerm.toLowerCase())).join('\n')
        : content;

    return (
        <div className="p-6 h-full flex flex-col overflow-hidden">
            <header className="mb-6 flex justify-between items-center">
                <div>
                    <h1 className="text-2xl font-bold text-slate-100 tracking-tight flex items-center gap-2">
                        <Terminal className="w-6 h-6 text-slate-400" />
                        Diagnostics & Logs
                    </h1>
                    <p className="text-sm text-slate-400 mt-1">Raw telemetry logs from the backend engine</p>
                </div>
            </header>

            <div className="flex-1 grid grid-cols-12 gap-6 min-h-0">
                {/* Log List Sidebar */}
                <div className="col-span-12 lg:col-span-3 flex flex-col bg-slate-800/40 rounded-xl border border-slate-700/50 overflow-hidden">
                    <div className="p-4 border-b border-slate-700 flex items-center gap-2 bg-slate-800/20">
                        <FileText className="w-4 h-4 text-indigo-400" />
                        <h2 className="text-sm font-semibold text-slate-200">Log Files</h2>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                        {files.map(file => (
                            <button
                                key={file}
                                onClick={() => setSelectedFile(file)}
                                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono transition-all flex items-center justify-between group ${
                                    selectedFile === file 
                                    ? 'bg-indigo-500/10 text-indigo-300 border border-indigo-500/30' 
                                    : 'text-slate-400 hover:bg-slate-700/30 border border-transparent'
                                }`}
                            >
                                <span className="truncate">{file}</span>
                                <ChevronRight className={`w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity ${selectedFile === file ? 'opacity-100' : ''}`} />
                            </button>
                        ))}
                    </div>
                </div>

                {/* Log Viewer Content */}
                <div className="col-span-12 lg:col-span-9 flex flex-col bg-slate-900 rounded-xl border border-slate-700/50 overflow-hidden">
                    <div className="p-3 border-b border-slate-700 flex items-center justify-between bg-slate-800/50">
                        <div className="flex items-center gap-4 flex-1 max-w-xl">
                            <div className="relative flex-1">
                                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-500" />
                                <input
                                    type="text"
                                    placeholder="Search log entries..."
                                    value={searchTerm}
                                    onChange={e => setSearchTerm(e.target.value)}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg pl-9 pr-4 py-1.5 text-xs text-slate-300 outline-none focus:border-indigo-500 transition-colors"
                                />
                            </div>
                        </div>
                        <div className="flex items-center gap-4 ml-4">
                            <span className="text-[10px] text-slate-500 font-mono uppercase truncate max-w-40">{selectedFile}</span>
                            <button 
                                onClick={() => setRefreshKey(key => key + 1)}
                                disabled={!selectedFile}
                                className="p-1.5 hover:bg-slate-700 rounded text-slate-400 transition-colors"
                                title="Refresh"
                            >
                                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                            </button>
                        </div>
                    </div>
                    <div className="flex-1 overflow-auto bg-black/40 relative">
                        {loading && (
                            <div className="absolute inset-0 bg-slate-900/50 flex items-center justify-center z-10 backdrop-blur-sm">
                                <RefreshCw className="w-8 h-8 text-indigo-500 animate-spin" />
                            </div>
                        )}
                        <pre 
                            ref={scrollRef}
                            className="p-4 font-mono text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap selection:bg-indigo-500/30"
                        >
                            {filteredContent || <span className="text-slate-600 italic">No content found.</span>}
                        </pre>
                    </div>
                </div>
            </div>
        </div>
    );
}
